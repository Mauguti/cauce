import { createHash } from "node:crypto";
import type { FotoPrecios } from "@cauce/core";
import { registrar, registrarError } from "../log.ts";

/**
 * Lee `precios.json` que publica la plataforma (generado en su build desde
 * lib/precios.ts, la única fuente). El orquestador no tiene precios en
 * código. Regla de falla: sin foto nunca leída, NO se cobra y se avisa;
 * con una foto vieja y la URL caída, se usa la última y se registra.
 */
export interface FotoLeida {
  precios: FotoPrecios;
  hash: string;
  leidoEn: string;
  origen: "url" | "cache";
}

const CAMPOS: (keyof FotoPrecios)[] = ["version", "IVA", "PRECIO_PLAN", "LINEAS_INCLUIDAS", "LINEA_ADICIONAL", "AGENTE", "PERIODOS"];

export function validarFoto(x: unknown): FotoPrecios {
  if (!x || typeof x !== "object") throw new Error("precios.json no es un objeto");
  const o = x as Record<string, unknown>;
  for (const k of CAMPOS) if (!(k in o)) throw new Error(`precios.json sin ${k}`);
  const p = o as unknown as FotoPrecios;
  for (const plan of ["basico", "estandar", "pro"] as const) {
    if (!(Number(p.PRECIO_PLAN?.[plan]) > 0)) throw new Error(`precios.json: PRECIO_PLAN.${plan} inválido`);
  }
  for (const per of ["mensual", "semestral", "anual"] as const) {
    if (!(Number(p.PERIODOS?.[per]?.meses) > 0)) throw new Error(`precios.json: PERIODOS.${per} inválido`);
  }
  if (!(p.IVA >= 0 && p.IVA < 1)) throw new Error("precios.json: IVA inválido");
  return p;
}

export class CargadorPrecios {
  readonly #url: string | null;
  readonly #fetch: typeof fetch;
  #ultima: FotoLeida | null = null;

  constructor(opciones: { url: string | null | undefined; fetchImpl?: typeof fetch; inicial?: FotoPrecios }) {
    this.#url = opciones.url?.trim() || null;
    this.#fetch = opciones.fetchImpl ?? fetch;
    if (opciones.inicial) this.#ultima = { precios: opciones.inicial, hash: hashDe(JSON.stringify(opciones.inicial)), leidoEn: new Date().toISOString(), origen: "cache" };
  }

  /** Foto vigente: la de la URL si responde; si no, la última leída; si nunca hubo, null. */
  async obtener(): Promise<FotoLeida | null> {
    if (!this.#url) {
      if (!this.#ultima) registrar("precios.sin_url", { nota: "CAUCE_PRECIOS_URL sin definir y sin foto inicial: no se cobra" }, "error");
      return this.#ultima;
    }
    try {
      const res = await this.#fetch(this.#url, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const texto = await res.text();
      const precios = validarFoto(JSON.parse(texto));
      const hash = hashDe(JSON.stringify(precios));
      if (this.#ultima?.hash !== hash) registrar("precios.leidos", { url: this.#url, version: precios.version, hash, anterior: this.#ultima?.hash ?? null });
      this.#ultima = { precios, hash, leidoEn: new Date().toISOString(), origen: "url" };
      return this.#ultima;
    } catch (err) {
      registrarError("precios.error", err, { url: this.#url, usaCache: Boolean(this.#ultima), hashCache: this.#ultima?.hash ?? null });
      return this.#ultima ? { ...this.#ultima, origen: "cache" } : null;
    }
  }
}

export function hashDe(texto: string): string {
  return createHash("sha256").update(texto).digest("hex").slice(0, 16);
}
