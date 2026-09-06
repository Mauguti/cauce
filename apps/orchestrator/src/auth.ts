import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Tenant } from "@cauce/core";
import type { Repositorio } from "./store.ts";
import { pareceJwt, type VerificadorToken } from "./firebase.ts";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function hashesIguales(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Resuelve el tenant desde una API key (x-api-key), o null. */
async function tenantPorApiKey(
  repo: Repositorio,
  key: string,
): Promise<Tenant | null> {
  const hashPresentado = hashApiKey(key);
  let encontrado: Tenant | null = null;
  // Comparación timing-safe sobre todos para no filtrar cuál hash existe.
  for (const tenant of await repo.listTenants()) {
    if (hashesIguales(hashPresentado, tenant.apiKeyHash)) encontrado = tenant;
  }
  return encontrado;
}

/**
 * Autenticación (ver docs/adr/0002 y docs/auth-usuarios.md). Dos vías,
 * ambas derivan el tenant de la credencial, nunca del path:
 *
 * - `Authorization: Bearer <ID token de Firebase>` → la consola. Se
 *   verifica el token, se resuelve uid → tenant (usuarios/{uid}).
 * - `x-api-key` (o Bearer no-JWT) → integraciones máquina a máquina.
 *
 * Si el path trae tenantId y no coincide, 401 idéntico al de credencial
 * inválida: la respuesta nunca revela si un tenant existe.
 */
export function autenticar(repo: Repositorio, verificar?: VerificadorToken) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiKeyHeader = req.headers["x-api-key"];
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

    let autenticado: Tenant | null = null;

    if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
      autenticado = await tenantPorApiKey(repo, apiKeyHeader);
    } else if (bearer && verificar && pareceJwt(bearer)) {
      // ID token de Firebase (consola).
      try {
        const identidad = await verificar(bearer);
        const tenantId = await repo.getTenantIdDeUsuario(identidad.uid);
        autenticado = tenantId ? await repo.getTenant(tenantId) : null;
      } catch {
        autenticado = null;
      }
    } else if (bearer) {
      // Bearer que no es JWT: API key por compatibilidad.
      autenticado = await tenantPorApiKey(repo, bearer);
    }

    if (!autenticado || autenticado.estado !== "activo") {
      res.status(401).json({ error: "no autorizado" });
      return;
    }

    const tenantEnPath = req.params.tenantId;
    if (typeof tenantEnPath === "string" && tenantEnPath !== autenticado.id) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }

    req.tenantId = autenticado.id;
    next();
  };
}
