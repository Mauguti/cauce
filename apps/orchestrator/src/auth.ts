import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Repositorio } from "./store.ts";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function hashesIguales(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Autenticación por API key (ver docs/adr/0002): el tenant se deriva de
 * la key presentada en `x-api-key` (o `Authorization: Bearer`), nunca
 * del path. Si el path trae un tenantId, se valida contra la key; si no
 * coincide, 401 idéntico al de key inválida — la respuesta jamás revela
 * si un tenant existe.
 */
export function autenticar(repo: Repositorio) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const encabezado = req.headers["x-api-key"];
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const key =
      typeof encabezado === "string" && encabezado.length > 0
        ? encabezado
        : bearer;
    if (!key) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }

    const hashPresentado = hashApiKey(key);
    let autenticado = null;
    // Se recorren todos los tenants con comparación timing-safe para no
    // filtrar por tiempo de respuesta cuál hash existe.
    for (const tenant of await repo.listTenants()) {
      if (hashesIguales(hashPresentado, tenant.apiKeyHash)) {
        autenticado = tenant;
      }
    }
    if (!autenticado || autenticado.estado !== "activo") {
      res.status(401).json({ error: "no autorizado" });
      return;
    }

    const tenantEnPath = req.params.tenantId;
    if (
      typeof tenantEnPath === "string" &&
      tenantEnPath !== autenticado.id
    ) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }

    req.tenantId = autenticado.id;
    next();
  };
}
