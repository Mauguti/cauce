import express, { type Request, type Response, type NextFunction } from "express";
import type { TenantId } from "@cauce/core";
import type { Repositorio } from "./store.ts";

declare global {
  namespace Express {
    interface Request {
      tenantId?: TenantId;
    }
  }
}

/**
 * Toda ruta de datos cuelga de /api/tenants/:tenantId y pasa por este
 * middleware: valida que el tenant exista y lo fija en la request.
 *
 * TODO auth real: el tenantId debe derivarse de la identidad autenticada,
 * no confiarse del path. Hoy no hay autenticación (fuera de alcance).
 */
function scopeTenant(repo: Repositorio) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId =
      typeof req.params.tenantId === "string" ? req.params.tenantId : undefined;
    if (!tenantId) {
      res.status(400).json({ error: "tenantId requerido" });
      return;
    }
    const tenant = await repo.getTenant(tenantId);
    if (!tenant || tenant.estado !== "activo") {
      res.status(404).json({ error: "tenant no encontrado" });
      return;
    }
    req.tenantId = tenantId;
    next();
  };
}

export function crearApp(repo: Repositorio): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(scopeTenant(repo));

  tenantRouter.get("/instances", async (req, res) => {
    res.json(await repo.listInstances(req.tenantId!));
  });

  tenantRouter.get("/instances/:instanceId", async (req, res) => {
    const instance = await repo.getInstance(
      req.tenantId!,
      req.params.instanceId!,
    );
    if (!instance) {
      res.status(404).json({ error: "instancia no encontrada" });
      return;
    }
    res.json(instance);
  });

  app.use("/api/tenants/:tenantId", tenantRouter);

  return app;
}
