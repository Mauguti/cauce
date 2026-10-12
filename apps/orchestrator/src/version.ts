import { execFileSync } from "node:child_process";
import { registrar } from "./log.ts";

/**
 * Versión desplegada para /health y el log de arranque. Se deriva del
 * commit real del directorio del código (git), nunca de algo que alguien
 * pone a mano: `/health` es el único instrumento para saber qué está
 * arriba y una variable olvidada en el entorno lo hacía mentir
 * (12-oct-2026: el servicio corría d82e39c y /health decía ee67555).
 *
 * `CAUCE_VERSION` solo se usa cuando no hay repositorio (p. ej. un
 * artefacto sin .git); si existe y no coincide con git, se ignora y queda
 * en bitácora para que alguien la borre del entorno.
 */
export function resolverVersion(o: { git: { hash: string; sucio: boolean } | null; env: string | undefined }): string {
  const env = o.env?.trim() || null;
  if (o.git?.hash) {
    const version = `${o.git.hash}${o.git.sucio ? "+" : ""}`;
    if (env && env !== o.git.hash && env !== version) {
      registrar("version.env_ignorada", { env, git: version, nota: "CAUCE_VERSION no coincide con el commit desplegado; bórrala del entorno" }, "warn");
    }
    return version;
  }
  return env ?? "dev";
}

/** HEAD corto y si hay cambios sin commitear, o null si no hay repositorio. */
export function leerGit(raiz: string): { hash: string; sucio: boolean } | null {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: raiz, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!hash) return null;
    const sucio = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: raiz, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return { hash, sucio };
  } catch {
    return null;
  }
}

export function versionDesplegada(raiz: string): string {
  return resolverVersion({ git: leerGit(raiz), env: process.env.CAUCE_VERSION });
}
