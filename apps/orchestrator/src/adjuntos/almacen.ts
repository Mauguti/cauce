import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, stat, readdir, readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import type { Adjunto, TenantId } from "@cauce/core";
import { ADJUNTO_MAX_BYTES } from "@cauce/core";
import { registrar } from "../log.ts";

// ── Configuración ───────────────────────────────────────────────────────

const DIR_DEFAULT = process.env.CAUCE_ADJUNTOS_DIR ?? "/var/cauce/adjuntos";

/** Horas de validez de una URL firmada. */
const FIRMA_HORAS = 24;

// ── URL firmada ─────────────────────────────────────────────────────────

/**
 * Genera un token firmado para servir un adjunto. El token contiene la
 * ruta, la expiración y un HMAC-SHA256 que el servidor valida al servir.
 * El formato es: `hex(hmac):expirationIso:ruta`.
 */
export function firmarUrl(
  ruta: string,
  llave: Buffer,
  horasValidez: number = FIRMA_HORAS,
): string {
  const expira = new Date(Date.now() + horasValidez * 3_600_000).toISOString();
  const datos = `${expira}:${ruta}`;
  const mac = createHmac("sha256", llave).update(datos).digest("hex");
  // Token URL-safe: base64url del json { m, e, r }
  const payload = Buffer.from(JSON.stringify({ m: mac, e: expira, r: ruta })).toString("base64url");
  return payload;
}

/**
 * Valida un token firmado. Devuelve la ruta del archivo si el token es
 * válido y no ha expirado; null en caso contrario.
 */
export function verificarFirma(
  token: string,
  llave: Buffer,
): string | null {
  try {
    const { m: mac, e: expira, r: ruta } = JSON.parse(Buffer.from(token, "base64url").toString());
    if (typeof mac !== "string" || typeof expira !== "string" || typeof ruta !== "string") return null;
    if (new Date(expira) <= new Date()) return null;
    const datos = `${expira}:${ruta}`;
    const esperado = createHmac("sha256", llave).update(datos).digest("hex");
    if (mac !== esperado) return null;
    return ruta;
  } catch {
    return null;
  }
}

// ── Almacenamiento en disco ─────────────────────────────────────────────

export interface OpcionesAlmacen {
  directorio?: string;
  llave: Buffer;
}

export class AlmacenAdjuntos {
  readonly directorio: string;
  readonly #llave: Buffer;

  constructor(opciones: OpcionesAlmacen) {
    this.directorio = opciones.directorio ?? DIR_DEFAULT;
    this.#llave = opciones.llave;
  }

  /**
   * Guarda un adjunto en disco. Devuelve los metadatos del adjunto, o
   * null si excede el tope de tamaño (con el tamaño real para el aviso).
   */
  async guardar(
    tenantId: TenantId,
    instanceId: string,
    messageId: string,
    contenido: Buffer,
    metadata: { nombre: string; tipoMime: string },
  ): Promise<Adjunto | null> {
    if (contenido.length > ADJUNTO_MAX_BYTES) {
      registrar("adjuntos.excede_tope", {
        tenant: tenantId,
        instancia: instanceId,
        mensaje: messageId,
        nombre: metadata.nombre,
        tamano: contenido.length,
        topeMb: Math.round(ADJUNTO_MAX_BYTES / (1024 * 1024)),
      }, "warn");
      return null;
    }

    const id = randomUUID();
    const ext = extname(metadata.nombre) || extensionDeMime(metadata.tipoMime);
    const ruta = join(tenantId, instanceId, messageId, `${id}${ext}`);
    const rutaAbsoluta = join(this.directorio, ruta);

    await mkdir(dirname(rutaAbsoluta), { recursive: true });
    await writeFile(rutaAbsoluta, contenido);

    registrar("adjuntos.guardado", {
      tenant: tenantId,
      instancia: instanceId,
      mensaje: messageId,
      nombre: metadata.nombre,
      tamano: contenido.length,
      tipoMime: metadata.tipoMime,
    });

    return {
      id,
      nombre: metadata.nombre,
      tipoMime: metadata.tipoMime,
      tamano: contenido.length,
      ruta,
      guardadoEn: new Date().toISOString(),
    };
  }

  /** Lee el contenido de un adjunto desde disco. */
  async leer(ruta: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.directorio, ruta));
    } catch {
      return null;
    }
  }

  /** Borra un adjunto de disco. Devuelve true si existía. */
  async borrar(ruta: string): Promise<boolean> {
    try {
      await unlink(join(this.directorio, ruta));
      return true;
    } catch {
      return false;
    }
  }

  /** Genera un token firmado para servir este adjunto. */
  urlFirmada(ruta: string, horas: number = FIRMA_HORAS): string {
    return firmarUrl(ruta, this.#llave, horas);
  }

  /** Valida un token y devuelve la ruta del archivo, o null. */
  verificar(token: string): string | null {
    return verificarFirma(token, this.#llave);
  }

  /**
   * Calcula el uso total de disco de un tenant recorriendo su directorio.
   * Devuelve 0 si el directorio no existe.
   */
  async usoPorTenant(tenantId: TenantId): Promise<number> {
    const dir = join(this.directorio, tenantId);
    return sumarBytes(dir);
  }
}

// ── Utilidades ──────────────────────────────────────────────────────────

function extensionDeMime(mime: string): string {
  const base = mime.split(";")[0].trim();
  const mapa: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/ogg; codecs=opus": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  };
  return mapa[base] ?? "";
}

/** Suma recursiva de bytes en un directorio. */
async function sumarBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const ruta = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await sumarBytes(ruta);
      } else {
        try {
          const s = await stat(ruta);
          total += s.size;
        } catch { /* archivo borrado entre readdir y stat */ }
      }
    }
  } catch { /* directorio no existe */ }
  return total;
}
