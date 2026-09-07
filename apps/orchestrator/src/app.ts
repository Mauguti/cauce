import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import type { TenantId } from "@cauce/core";
import type { Repositorio } from "./store.ts";
import { SesionNoCerrada, type GestorSesiones } from "./sesiones.ts";
import { autenticar } from "./auth.ts";
import type { ColaEnvios } from "./cola.ts";
import type { ConectorMonday } from "./monday/conector.ts";
import type { MotorEntrada } from "./entrada/motor.ts";
import type { DisparadorEntrada } from "./entrada/disparadores.ts";
import type { VerificadorToken } from "./firebase.ts";
import type { Provisioning } from "./provisioning.ts";
import { churnReciente, limitesTenant, pruebaVigente } from "@cauce/core";
import { normalizarActualizacion, normalizarEntrante } from "./webhook.ts";

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
      res.setHeader(
        "access-control-allow-headers",
        "content-type, x-api-key, authorization",
      );
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
  /** Verificador de ID tokens de Firebase (login de la consola). */
  verificarToken?: VerificadorToken;
  /** Provisioning autoservicio de tenants. */
  provisioning?: Provisioning;
  /** Clave del endpoint admin de cambio de plan. */
  adminKey?: string;
  /** Versión desplegada (commit corto); se expone en /health. */
  version?: string;
}

export function crearApp(
  repo: Repositorio,
  gestor?: GestorSesiones,
  opciones: AppOpciones = {},
): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cors(opciones.corsOrigenes ?? []));

  // /health expone la versión desplegada para que la consola detecte
  // desfases consola↔orquestador (ver docs/deploy.md, scripts/deploy.sh).
  const version = opciones.version ?? process.env.CAUCE_VERSION ?? "dev";
  app.get("/health", (_req, res) => {
    res.json({ ok: true, version });
  });

  /**
   * Webhook nativo de monday. Va ANTES del webhook genérico de instancias
   * porque `/webhooks/:tenantId/:instanceId` también casaría
   * `/webhooks/monday/demo` (con tenantId="monday"); el orden lo evita.
   * No pasa por la auth de tenant: monday no manda nuestra API key. Su
   * seguridad es (1) el challenge de alta y (2) el JWT firmado con el
   * Signing Secret del tenant. El tenantId viene en el path.
   */
  app.post(
    ["/webhooks/monday/:tenantId", "/webhooks/monday/:tenantId/:plantillaId"],
    async (req, res) => {
    const tenantId = String(req.params.tenantId);
    // Plantilla apuntada por esta URL; ausente = la por defecto (URL corta,
    // compatible con automatizaciones ya configuradas).
    const plantillaId = req.params.plantillaId
      ? String(req.params.plantillaId)
      : undefined;
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
    // Deja rastro de que monday llamó (para "¿ya me llamó?" en la UI).
    void opciones.monday.registrarLlamada(tenantId);
    // Responder rápido; el disparo (leer item, encolar envío) es trabajo
    // que no debe hacer esperar a monday ni tumbar su reintento.
    res.status(200).json({ ok: true });
    opciones.monday
      .procesarEvento(tenantId, req.body?.event, plantillaId)
      .catch((err) =>
        console.warn(`monday procesarEvento falló: ${err?.message}`),
      );
  },
  );

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
    // Confirmación de entrega de un saliente (MESSAGES_UPDATE): registra la
    // transición real. Sin SERVER_ACK, el barrido lo pasará a no_confirmado.
    const actualizacion = normalizarActualizacion(req.body);
    if (actualizacion) {
      const m = await repo.getMessagePorExternalId(
        tenantId!,
        actualizacion.externalId,
      );
      if (m) {
        await repo.saveMessage(
          actualizacion.ack === "confirmado"
            ? // Entregado: confirma y recupera si estaba no_confirmado.
              {
                ...m,
                estado: "enviado",
                confirmadoEn: new Date().toISOString(),
                error: null,
                errorCodigo: null,
              }
            : // WhatsApp reportó ERROR: no se entregó.
              { ...m, estado: "no_confirmado", confirmadoEn: null },
        );
      }
      res.status(200).json({ ok: true });
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

  // Alta autoservicio: la consola llama tras el login con el ID token de
  // Firebase. "Dame mi tenant, créalo si no existe" — idempotente.
  app.post("/api/provisionar", async (req, res) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer || !opciones.verificarToken || !opciones.provisioning) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }
    let identidad;
    try {
      identidad = await opciones.verificarToken(bearer);
    } catch {
      res.status(401).json({ error: "token inválido" });
      return;
    }
    const { tenant, apiKey } = await opciones.provisioning.provisionar(identidad);
    res.status(200).json({
      tenantId: tenant.id,
      nombre: tenant.nombre,
      plan: tenant.plan,
      // apiKey solo en el alta nueva; después null.
      apiKey,
    });
  });

  // Identidad + plan del tenant autenticado; lo que la consola necesita
  // para construir el resto de las rutas y mostrar límites/vigencia.
  app.get("/api/me", autenticar(repo, opciones.verificarToken), async (req, res) => {
    const tenant = (await repo.getTenant(req.tenantId!))!;
    const limites = limitesTenant(tenant);
    res.json({
      tenantId: tenant.id,
      nombre: tenant.nombre,
      plan: tenant.plan,
      limites,
      pruebaExpiraEn: tenant.pruebaExpiraEn ?? null,
      pruebaVigente: pruebaVigente(tenant),
      terminosAceptados: Boolean(tenant.terminosAceptadosEn),
      // Creó/borró sesiones en ráfaga: la consola avisa antes de recrear.
      churnReciente: churnReciente(tenant),
    });
  });

  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(autenticar(repo, opciones.verificarToken));

  // Registra la aceptación de las condiciones de uso del número.
  tenantRouter.post("/onboarding/aceptar-terminos", async (req, res) => {
    const tenant = (await repo.getTenant(req.tenantId!))!;
    if (!tenant.terminosAceptadosEn) {
      await repo.saveTenant({
        ...tenant,
        terminosAceptadosEn: new Date().toISOString(),
      });
    }
    res.status(204).end();
  });

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

  // Rastro observable del conector: última llamada de monday y resultado.
  tenantRouter.get("/conectores/monday/registro", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    res.json(await opciones.monday.verRegistro(req.tenantId!));
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

  // Reemplaza la lista de plantillas salientes (varias por conexión, cada
  // una con su propia URL de webhook).
  tenantRouter.put("/conectores/monday/plantillas", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const { plantillas } = req.body ?? {};
    if (
      !Array.isArray(plantillas) ||
      plantillas.length === 0 ||
      !plantillas.every(
        (p) =>
          p &&
          typeof p.id === "string" &&
          p.id.length > 0 &&
          typeof p.nombre === "string" &&
          typeof p.cuerpo === "string",
      )
    ) {
      res.status(400).json({
        error: "se requiere al menos una plantilla con id, nombre y cuerpo",
      });
      return;
    }
    const ids = new Set(plantillas.map((p) => p.id));
    if (ids.size !== plantillas.length) {
      res.status(400).json({ error: "hay plantillas con id repetido" });
      return;
    }
    const ok = await opciones.monday.guardarPlantillas(
      req.tenantId!,
      plantillas,
    );
    if (!ok) {
      res.status(409).json({ error: "configura primero la conexión monday" });
      return;
    }
    res.status(204).end();
  });

  // Alta/edición del conector: cifra credenciales en reposo. Al editar,
  // apiToken/signingSecret pueden venir vacíos y se conservan los ya
  // guardados (el token va enmascarado en la UI).
  tenantRouter.put("/conectores/monday", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    const {
      instanceId,
      boardId,
      boardNombre,
      apiToken,
      signingSecret,
      columnaTelefono,
      plantilla,
    } = req.body ?? {};
    if (
      typeof instanceId !== "string" ||
      typeof boardId !== "string" ||
      typeof columnaTelefono !== "string"
    ) {
      res.status(400).json({
        error: "se requieren instanceId, boardId y columnaTelefono",
      });
      return;
    }
    // Límite de conectores: solo aplica al DAR DE ALTA uno nuevo (editar
    // el existente no cuenta). Hoy monday es el único tipo, así que el
    // conteo es 0 o 1; el guard queda listo para Bitrix/Pipedrive.
    const yaExiste = (await opciones.monday.verConfig(req.tenantId!)) !== null;
    if (!yaExiste) {
      const tenant = (await repo.getTenant(req.tenantId!))!;
      const limite = limitesTenant(tenant).conectores;
      const conectoresActuales = 0; // monday es el único tipo; ninguno aún
      if (conectoresActuales + 1 > limite) {
        res.status(403).json({
          error: `Tu plan permite ${limite} ${limite === 1 ? "conector" : "conectores"}. Contrata más para agregar otro.`,
        });
        return;
      }
    }
    try {
      await opciones.monday.guardarAlta(req.tenantId!, {
        instanceId,
        boardId,
        boardNombre: typeof boardNombre === "string" ? boardNombre : "",
        apiToken: typeof apiToken === "string" ? apiToken : "",
        signingSecret: typeof signingSecret === "string" ? signingSecret : "",
        columnaTelefono,
        ...(typeof plantilla === "string" ? { plantilla } : {}),
      });
      res.status(204).end();
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? "no se pudo guardar" });
    }
  });

  // Quitar la conexión: borra credenciales cifradas; el disparo saliente
  // desde monday queda inactivo hasta reconectar.
  tenantRouter.delete("/conectores/monday", async (req, res) => {
    if (!opciones.monday) {
      res.status(501).json({ error: "conector monday no disponible" });
      return;
    }
    await opciones.monday.desconectar(req.tenantId!);
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
    // Límites por plan: validados en el servidor, con mensaje claro.
    const tenant = (await repo.getTenant(req.tenantId!))!;
    if (!pruebaVigente(tenant)) {
      res.status(403).json({
        error:
          "Tu prueba terminó. Contrata un plan para conectar números; tus datos y conversaciones siguen guardados.",
      });
      return;
    }
    const limites = limitesTenant(tenant);
    const actuales = await repo.listInstances(req.tenantId!);
    if (actuales.length >= limites.lineas) {
      res.status(403).json({
        error: `Tu plan permite ${limites.lineas} ${limites.lineas === 1 ? "línea" : "líneas"}. Elimina una o contrata más para agregar otra.`,
      });
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

  // Todos los mensajes del tenant (dashboard): recientes primero.
  tenantRouter.get("/messages", async (req, res) => {
    const mensajes = await repo.listMessages(req.tenantId!);
    mensajes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(mensajes.slice(0, 200));
  });

  // Reintento manual de un mensaje fallido: re-encola el MISMO mensaje
  // (sin recrear la acción ni esperar otro evento). Solo si la causa era
  // reintentable — un teléfono vacío no se arregla reintentando.
  tenantRouter.post("/messages/:messageId/retry", async (req, res) => {
    if (!opciones.cola) {
      res.status(501).json({ error: "orquestador sin cola de envíos" });
      return;
    }
    const mensaje = await repo.getMessage(req.tenantId!, String(req.params.messageId));
    if (!mensaje) {
      res.status(404).json({ error: "mensaje no encontrado" });
      return;
    }
    if (mensaje.estado !== "fallido" || mensaje.direccion !== "out") {
      res.status(409).json({ error: "solo se reintentan mensajes salientes fallidos" });
      return;
    }
    const noReintentable = mensaje.errorCodigo === "telefono_vacio" ||
      mensaje.errorCodigo === "telefono_invalido" ||
      mensaje.errorCodigo === "item_incompleto";
    if (noReintentable) {
      res.status(409).json({
        error: "Este fallo no se corrige reintentando; arregla el item o el teléfono y dispara de nuevo desde monday.",
      });
      return;
    }
    if (!gestor?.obtener(mensaje.instanceId)) {
      res.status(409).json({ error: "la sesión no está activa; reconéctala en Sesiones y reintenta" });
      return;
    }
    // Re-encola el mismo mensaje (mismo id → upsert; se limpia el error).
    await opciones.cola.encolar({
      ...mensaje,
      estado: "encolado",
      error: null,
      errorCodigo: null,
      timestamp: new Date().toISOString(),
    });
    res.status(202).json({ id: mensaje.id, estado: "encolado" });
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
    try {
      await gestor.eliminar(req.tenantId!, req.params.instanceId!);
    } catch (err) {
      // Logout sin confirmar: no se borró nada. El número queda intacto y
      // el usuario debe cerrar la sesión desde su teléfono antes de que
      // borrarla sea seguro.
      if (err instanceof SesionNoCerrada) {
        res.status(409).json({
          error:
            "No pudimos cerrar la sesión de WhatsApp de este número, así que no lo eliminamos. Borrarlo así deja el número vinculado a medias y puede dañarlo. Ciérralo desde tu teléfono (WhatsApp → Dispositivos vinculados → cierra esta sesión) y vuelve a intentar. Si solo quieres pausarlo, usa Desconectar.",
        });
        return;
      }
      throw err;
    }
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

  // Cambio de plan MANUAL (Stripe va en otro bloque). Autenticado con
  // CAUCE_ADMIN_KEY, no con credenciales de tenant. Sube a plan pagado
  // (limpia la caducidad) o ajusta límites contratados ("extras").
  app.post("/api/admin/tenants/:tenantId/plan", async (req, res) => {
    const admin = req.headers["x-admin-key"];
    if (!opciones.adminKey || admin !== opciones.adminKey) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }
    const tenant = await repo.getTenant(String(req.params.tenantId));
    if (!tenant) {
      res.status(404).json({ error: "tenant no encontrado" });
      return;
    }
    const { plan, limiteLineas, limiteConectores } = req.body ?? {};
    if (plan !== "prueba" && plan !== "base" && plan !== "extras") {
      res.status(400).json({ error: "plan inválido (prueba|base|extras)" });
      return;
    }
    const actualizado = {
      ...tenant,
      plan,
      // Al pasar a un plan pagado se limpia la caducidad de prueba.
      pruebaExpiraEn: plan === "prueba" ? tenant.pruebaExpiraEn ?? null : null,
      ...(typeof limiteLineas === "number" ? { limiteLineas } : {}),
      ...(typeof limiteConectores === "number" ? { limiteConectores } : {}),
    };
    await repo.saveTenant(actualizado);
    res.json({ tenantId: actualizado.id, plan: actualizado.plan });
  });

  return app;
}
