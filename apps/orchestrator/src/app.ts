import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import type { TenantId } from "@cauce/core";
import type { Repositorio } from "./store.ts";
import type { GestorSesiones } from "./sesiones.ts";
import { autenticar } from "./auth.ts";
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
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE");
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
    // Responder rápido: normalizar y guardar es barato; cualquier
    // trabajo pesado futuro (escribir al CRM) se encola, no se hace aquí.
    const mensaje = normalizarEntrante(tenantId!, instanceId!, req.body);
    if (mensaje) await repo.saveMessage(mensaje);
    res.status(200).json({ ok: true });
  });

  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(autenticar(repo));

  tenantRouter.get("/instances", async (req, res) => {
    res.json(await repo.listInstances(req.tenantId!));
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

  tenantRouter.get("/instances/:instanceId/qr", async (req, res) => {
    const sesion = await sesionScopeada(req, res);
    if (!sesion) return;
    const qr = await sesion.transport.getQr();
    if (!qr) {
      res.status(404).json({ error: "no hay QR disponible en este estado" });
      return;
    }
    res.json({ codigo: qr.codigo, imagenBase64: qr.imagenBase64 });
  });

  tenantRouter.post("/instances/:instanceId/send", async (req, res) => {
    const sesion = await sesionScopeada(req, res);
    if (!sesion) return;
    const { telefono, cuerpo } = req.body ?? {};
    if (typeof telefono !== "string" || typeof cuerpo !== "string") {
      res.status(400).json({ error: "se requieren telefono y cuerpo" });
      return;
    }
    try {
      const recibo = await sesion.transport.send({ telefono, cuerpo });
      const mensaje = {
        id: crypto.randomUUID(),
        tenantId: req.tenantId!,
        instanceId: req.params.instanceId!,
        direccion: "out" as const,
        telefono,
        cuerpo,
        estado: "enviado" as const,
        externalId: recibo.externalId,
        timestamp: recibo.timestamp,
      };
      await repo.saveMessage(mensaje);
      res.status(201).json(mensaje);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "envío falló" });
    }
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
