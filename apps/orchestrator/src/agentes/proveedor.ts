import Anthropic from "@anthropic-ai/sdk";

/**
 * Proveedor de modelo: la única frontera entre el agente y el LLM. El
 * agente PIENSA EN EL ORQUESTADOR (nada de n8n para razonar); el proveedor
 * se elige por tenant en su configuración (`Tenant.agente.proveedor`) y hoy
 * existe uno, Anthropic. Un bake-off futuro agrega otro sin tocar al agente.
 *
 * Regla desde el primer commit: cada llamada devuelve tokens y costo, y el
 * agente los registra aunque no se cobre nada todavía.
 */

export interface Uso {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

export interface PeticionModelo {
  modelo: string;
  /** Instrucciones + base de conocimiento; se cachea como prefijo. */
  sistema: string;
  /** Conversación en orden cronológico; el último debe ser del usuario. */
  historial: { rol: "usuario" | "asistente"; texto: string }[];
  esfuerzo: "low" | "medium" | "high";
  maxSalida: number;
}

export interface RespuestaModelo {
  /** null si el modelo no contestó (rechazo o sin texto). */
  texto: string | null;
  /** Modelo que sirvió de verdad (puede diferir si hubo fallback). */
  modelo: string;
  uso: Uso;
  /** null si el modelo no está en la tabla de precios: se registra igual. */
  costoUsd: number | null;
  parada: string | null;
}

export interface ProveedorModelo {
  readonly nombre: string;
  responder(p: PeticionModelo): Promise<RespuestaModelo>;
}

/** USD por millón de tokens (tarifa pública de Anthropic, 2026-06). Caché: escritura ×1.25, lectura ×0.1. */
export const PRECIOS_USD_POR_MILLON: Record<string, { entrada: number; salida: number }> = {
  "claude-opus-5": { entrada: 5, salida: 25 },
  "claude-opus-4-8": { entrada: 5, salida: 25 },
  "claude-sonnet-5": { entrada: 2, salida: 10 },
  "claude-haiku-4-5": { entrada: 1, salida: 5 },
};

export function costoUsd(modelo: string, uso: Uso): number | null {
  const p = PRECIOS_USD_POR_MILLON[modelo];
  if (!p) return null;
  const usd =
    (uso.entrada * p.entrada + uso.cacheEscritura * p.entrada * 1.25 + uso.cacheLectura * p.entrada * 0.1 + uso.salida * p.salida) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Anthropic vía el SDK oficial. La llave sale de ANTHROPIC_API_KEY (por ahora la paga Digsol). */
export class ProveedorAnthropic implements ProveedorModelo {
  readonly nombre = "anthropic";
  readonly #client: Anthropic;

  constructor(opciones: { apiKey?: string; client?: Anthropic } = {}) {
    this.#client = opciones.client ?? new Anthropic(opciones.apiKey ? { apiKey: opciones.apiKey } : {});
  }

  async responder(p: PeticionModelo): Promise<RespuestaModelo> {
    // El historial debe abrir con el usuario; se descarta lo anterior si no.
    const desde = p.historial.findIndex((h) => h.rol === "usuario");
    const mensajes = (desde >= 0 ? p.historial.slice(desde) : []).map((h) => ({
      role: h.rol === "usuario" ? ("user" as const) : ("assistant" as const),
      content: h.texto,
    }));
    const res = await this.#client.beta.messages.create({
      model: p.modelo,
      max_tokens: p.maxSalida,
      // Si un clasificador declina, el servidor reintenta en el modelo de respaldo dentro de la misma llamada.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: p.esfuerzo },
      system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
      messages: mensajes,
    });
    const uso: Uso = {
      entrada: res.usage.input_tokens,
      salida: res.usage.output_tokens,
      cacheLectura: res.usage.cache_read_input_tokens ?? 0,
      cacheEscritura: res.usage.cache_creation_input_tokens ?? 0,
    };
    const texto = res.stop_reason === "refusal"
      ? null
      : res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
    return { texto, modelo: res.model, uso, costoUsd: costoUsd(res.model, uso), parada: res.stop_reason ?? null };
  }
}
