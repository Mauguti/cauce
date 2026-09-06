import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import type { TenantId } from "@cauce/core";
import type { Repositorio } from "./store.ts";
import type { GestorSesiones } from "./sesiones.ts";
import { autenticar } from "./auth.ts";
import type { ColaEnvios } from "./cola.ts";
import type { ConectorMonday } from "./monday/conector.ts";
import type { MotorEntrada } from "./entrada/motor.ts";
import type { DisparadorEntrada } from "./entrada/disparadores.ts";
import { normalizarEntrante } from "./webhook.ts";

declare global {
  namespace Express {
    interface Request {
      tenantId?: TenantId;
    }
  }
}

function tokenValido(recibido: unknown, esperado: string): boolean {
  if (typeof recibido !== "string") return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** CORS restringido: solo los orígenes de la allowlist (la consola). */
function cors(origenes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origen = req.headers.origin;
    if (typeof origen === "string" && origenes.includes(origen)) {
      res.setHeader("access-control-allow-origin", origen);
      res.setHeader("access-control-allow-headers", "content-type, x-api-key");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE");
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export interface AppOpciones {
  /** Orígenes permitidos para CORS (la consola). */
  corsOrigenes?: string[];
  /** Cola de envíos; sin ella POST /send responde 501. */
  cola?: ColaEnvios;
  /** Conector monday; sin él la ruta /webhooks/monday responde 501. */
  monday?: ConectorMonday;
  /** Motor de entrada; procesa cada mensaje entrante (conversación + disparadores). */
  motorEntrada?: MotorEntrada;
}

export function crearApp(
  repo: Repositorio,
  gestor?: GestorSesiones,
  opciones: AppOpciones = {},
): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cors(opciones.corsOrigenes ?? []));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Webhook nativo de monday. Va ANTES del webhook genérico de instancias
   * porque `/webhooks/:tenantId/:instanceId` también casaría
   * `/webhooks/monday/demo` (con tenantId="monday"); el orden lo evita.
   * No pasa por la auth de tenant: monday no manda nuestra API key. Su
   * seguridad es (1) el challenge de alta y (2) el JWT firmado con el
   * Signing Secret del tenant. El tenantId viene en el path.
   */
  app.post("/webhooks/monday/:tenantId", async (req, res) => {
    const tenantId = String(req.params.tenantId);
    // 1. Handshake de verificación: monday manda {challenge} al registrar
    //    el webhook y espera exactamente ese challenge de vuelta.
    if (req.body?.challenge) {
      res.status(200).json({ challenge: req.body.challenge });
      return;
    }
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const config = await repo.getConectorMonday(tenantId);
    if (!config) {
      res.status(404).json({ error: "tenant sin conector monday" });
      return;
    }
    // 2. Firma: JWT que monday envía en authorization.
    if (!opciones.monday.verificarFirma(config, req.headers.authorization)) {
      res.status(401).json({ error: "firma inválida" });
      return;
    }
    // Responder rápido; el disparo (leer item, encolar envío) es trabajo
    // que no debe hacer esperar a monday ni tumbar su reintento.
    res.status(200).json({ ok: true });
    opciones.monday
      .procesarEvento(tenantId, req.body?.event)
      .catch((err) =>
        console.warn(`monday procesarEvento falló: ${err?.message}`),
      );
  });

  /**
   * Webhook entrante desde las instancias. No pasa por scopeTenant: su
   * auth es el token secreto por instancia (query `token` o header
   * `x-cauce-token`); sin token válido la ruta no escribe nada.
   */
  app.post("/webhooks/:tenantId/:instanceId", async (req, res) => {
    const { tenantId, instanceId } = req.params as {
      tenantId: string;
      instanceId: string;
    };
    const sesion = gestor?.obtener(instanceId);
    if (!sesion) {
      res.status(404).json({ error: "instancia desconocida" });
      return;
    }
    const token = req.query.token ?? req.headers["x-cauce-token"];
    if (!tokenValido(token, sesion.webhookToken)) {
      res.status(401).json({ error: "token inválido" });
      return;
    }
    const instancia = await repo.getInstance(tenantId!, instanceId!);
    if (!instancia) {
      res.status(404).json({ error: "instancia desconocida" });
      return;
    }
    // Responder rápido: normalizar y guardar es barato. El resto
    // (conversación, disparadores, write-back al CRM) lo hace el motor de
    // entrada sin bloquear el 200; un fallo suyo no rompe la recepción.
    const mensaje = normalizarEntrante(tenantId!, instanceId!, req.body);
    if (mensaje) {
      await repo.saveMessage(mensaje);
      if (opciones.motorEntrada) {
        opciones.motorEntrada
          .procesar(tenantId!, instanceId!, mensaje)
          .catch((err) =>
            console.warn(`motor de entrada falló: ${err?.message}`),
          );
      }
    }
    res.status(200).json({ ok: true });
  });

  // Identidad del tenant dueño de la key; es lo único que la consola
  // necesita para construir el resto de las rutas.
  app.get("/api/me", autenticar(repo), async (req, res) => {
    const tenant = await repo.getTenant(req.tenantId!);
    res.json({ tenantId: tenant!.id, nombre: tenant!.nombre });
  });

  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(autenticar(repo));

  tenantRouter.get("/instances", async (req, res) => {
    res.json(await repo.listInstances(req.tenantId!));
  });

  // Vista de la config de monday: SIN secretos, solo la pista del token.
  tenantRouter.get("/conectores/monday", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    res.json(await opciones.monday.verConfig(req.tenantId!));
  });

  // Prueba de conexión: con el token del usuario, lista sus boards reales.
  tenantRouter.post("/conectores/monday/probar", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const { apiToken } = req.body ?? {};
    if (typeof apiToken !== "string" || !apiToken) {
      res.status(400).json({ error: "se requiere apiToken" });
      return;
    }
    try {
      const boards = await opciones.monday.listarBoards(apiToken);
      res.json({ ok: true, boards });
    } catch (err: any) {
      res.status(502).json({ ok: false, error: err?.message ?? "monday rechazó el token" });
    }
  });

  // Columnas de un board (para mapear el teléfono e insertar variables).
  tenantRouter.post("/conectores/monday/columnas", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const { apiToken, boardId } = req.body ?? {};
    if (typeof apiToken !== "string" || typeof boardId !== "string") {
      res.status(400).json({ error: "se requieren apiToken y boardId" });
      return;
    }
    try {
      res.json(await opciones.monday.listarColumnas(apiToken, boardId));
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "monday rechazó la consulta" });
    }
  });

  // Columnas del board ya configurado (editor de Acciones): usa el token
  // guardado, descifrado en el servidor; la consola no lo maneja.
  tenantRouter.get("/conectores/monday/board-columnas", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    try {
      res.json(await opciones.monday.columnasGuardadas(req.tenantId!));
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "monday rechazó la consulta" });
    }
  });

  // Actualiza solo la plantilla del mensaje saliente.
  tenantRouter.put("/conectores/monday/plantilla", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const { plantilla } = req.body ?? {};
    if (typeof plantilla !== "string") {
      res.status(400).json({ error: "se requiere plantilla" });
      return;
    }
    const ok = await opciones.monday.actualizarPlantilla(req.tenantId!, plantilla);
    if (!ok) {
      res.status(409).json({ error: "configura primero la conexión monday" });
      return;
    }
    res.status(204).end();
  });

  // Alta/edición del conector: cifra credenciales en reposo.
  tenantRouter.put("/conectores/monday", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const { instanceId, boardId, apiToken, signingSecret, columnaTelefono, plantilla } =
      req.body ?? {};
    if (
      typeof instanceId !== "string" ||
      typeof boardId !== "string" ||
      typeof apiToken !== "string" ||
      typeof columnaTelefono !== "string" ||
      typeof plantilla !== "string"
    ) {
      res.status(400).json({
        error:
          "se requieren instanceId, boardId, apiToken, columnaTelefono y plantilla",
      });
      return;
    }
    await opciones.monday.guardarAlta(req.tenantId!, {
      instanceId,
      boardId,
      apiToken,
      signingSecret: typeof signingSecret === "string" ? signingSecret : "",
      columnaTelefono,
      plantilla,
    });
    res.status(204).end();
  });

  // Disparadores de entrada del tenant: se listan y se reemplazan enteros.
  tenantRouter.get("/disparadores", async (req, res) => {
    res.json(await repo.getDisparadores(req.tenantId!));
  });

  tenantRouter.put("/disparadores", async (req, res) => {
    const lista = req.body;
    if (!Array.isArray(lista)) {
      res.status(400).json({ error: "se espera un arreglo de disparadores" });
      return;
    }
    const tipos = new Set([
      "primer_contacto",
      "palabra_clave",
      "cualquiera",
      "fuera_horario",
    ]);
    for (const d of lista as DisparadorEntrada[]) {
      if (
        typeof d?.id !== "string" ||
        typeof d?.prioridad !== "number" ||
        !tipos.has(d?.tipo) ||
        typeof d?.respuesta !== "string" ||
        typeof d?.activo !== "boolean"
      ) {
        res.status(400).json({ error: "disparador inválido" });
        return;
      }
      if (d.tipo === "palabra_clave" && !d.patron) {
        res.status(400).json({ error: "palabra_clave requiere patron" });
        return;
      }
      if (d.tipo === "fuera_horario" && !d.horario) {
        res.status(400).json({ error: "fuera_horario requiere horario" });
        return;
      }
    }
    await repo.saveDisparadores(req.tenantId!, lista as DisparadorEntrada[]);
    res.status(204).end();
  });

  tenantRouter.post("/instances", async (req, res) => {
    if (!gestor) {
      res.status(501).json({ error: "orquestador sin gestor de sesiones" });
      return;
    }
    try {
      const instancia = await gestor.crear(req.tenantId!);
      res.status(201).json(instancia);
    } catch (err: any) {
      res.status(502).json({ error: `no se pudo crear la sesión: ${err?.message}` });
    }
  });

  tenantRouter.get("/instances/:instanceId", async (req, res) => {
    const instanceId = req.params.instanceId!;
    const instancia = gestor
      ? await gestor.refrescar(req.tenantId!, instanceId)
      : await repo.getInstance(req.tenantId!, instanceId);
    if (!instancia) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    res.json(instancia);
  });

  // "No hay QR ahora mismo" (sesión pending o ya connected) es un estado
  // válido, no un recurso ausente: se responde 200 con QR nulo. El 404
  // queda reservado para instancia/sesión genuinamente inexistente
  // (lo emite sesionScopeada). Antes esto devolvía 404 y el polling del
  // modal ensuciaba la consola del navegador con 404 recurrentes.
  tenantRouter.get("/instances/:instanceId/qr", async (req, res) => {
    const sesion = await sesionScopeada(req, res);
    if (!sesion) return;
    const qr = await sesion.transport.getQr();
    res.json({
      codigo: qr?.codigo ?? null,
      imagenBase64: qr?.imagenBase64 ?? null,
    });
  });

  // Desconectar: logout, conserva contenedor y registro para reconectar.
  tenantRouter.post("/instances/:instanceId/disconnect", async (req, res) => {
    if (!gestor) {
      res.status(501).json({ error: "orquestador sin gestor de sesiones" });
      return;
    }
    const instancia = await repo.getInstance(req.tenantId!, String(req.params.instanceId));
    if (!instancia) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    res.json(await gestor.desconectar(req.tenantId!, String(req.params.instanceId)));
  });

  // Reconectar: vuelve a emitir QR para una sesión desconectada.
  tenantRouter.post("/instances/:instanceId/connect", async (req, res) => {
    if (!gestor) {
      res.status(501).json({ error: "orquestador sin gestor de sesiones" });
      return;
    }
    const instancia = await repo.getInstance(req.tenantId!, String(req.params.instanceId));
    if (!instancia) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    res.json(await gestor.reconectar(req.tenantId!, String(req.params.instanceId)));
  });

  // Encola y responde 202 de inmediato; el envío real lo hace el worker
  // de la cola respetando el ritmo por instancia.
  tenantRouter.post("/instances/:instanceId/send", async (req, res) => {
    const sesion = await sesionScopeada(req, res);
    if (!sesion) return;
    if (!opciones.cola) {
      res.status(501).json({ error: "orquestador sin cola de envíos" });
      return;
    }
    const { telefono, cuerpo } = req.body ?? {};
    if (typeof telefono !== "string" || typeof cuerpo !== "string") {
      res.status(400).json({ error: "se requieren telefono y cuerpo" });
      return;
    }
    const mensaje = {
      id: crypto.randomUUID(),
      tenantId: req.tenantId!,
      instanceId: String(req.params.instanceId),
      direccion: "out" as const,
      telefono,
      cuerpo,
      estado: "encolado" as const,
      externalId: null,
      timestamp: new Date().toISOString(),
    };
    await opciones.cola.encolar(mensaje);
    res.status(202).json({ id: mensaje.id, estado: mensaje.estado });
  });

  tenantRouter.get("/instances/:instanceId/messages", async (req, res) => {
    const instanceId = String(req.params.instanceId);
    const instancia = await repo.getInstance(req.tenantId!, instanceId);
    if (!instancia) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    const mensajes = await repo.listMessages(req.tenantId!, instanceId);
    mensajes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    res.json(mensajes);
  });

  tenantRouter.delete("/instances/:instanceId", async (req, res) => {
    if (!gestor) {
      res.status(501).json({ error: "orquestador sin gestor de sesiones" });
      return;
    }
    const instancia = await repo.getInstance(
      req.tenantId!,
      req.params.instanceId!,
    );
    if (!instancia) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    await gestor.eliminar(req.tenantId!, req.params.instanceId!);
    res.status(204).end();
  });

  /** Resuelve la sesión activa verificando que la instancia sea del tenant. */
  async function sesionScopeada(req: Request, res: Response) {
    const instanceId = String(req.params.instanceId);
    const instancia = await repo.getInstance(req.tenantId!, instanceId);
    if (!instancia || !gestor) {
      res.status(404).json({ error: "instancia no encontrada" });
      return null;
    }
    const sesion = gestor.obtener(instanceId);
    if (!sesion) {
      res.status(409).json({ error: "instancia sin sesión activa" });
      return null;
    }
    return sesion;
  }

  app.use("/api/tenants/:tenantId", tenantRouter);

  return app;
}
