import Anthropic from "@anthropic-ai/sdk";

/**
 * Proveedor de modelo: la única frontera entre el agente y el LLM. El
 * agente PIENSA EN EL ORQUESTADOR (nada de n8n para razonar); el proveedor
 * se elige por tenant en su configuración (`Tenant.agente.proveedor`) y hoy
 * existe uno, Anthropic. Un bake-off futuro agrega otro sin tocar al agente.
 *
 * Herramientas: el agente entrega definiciones y una función `ejecutar`;
 * el proveedor corre el ciclo de uso de herramientas (el modelo pide una,
 * se ejecuta, se le devuelve el resultado, y sigue) hasta que contesta
 * con texto o se agota el tope de rondas.
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

/** Definición de una herramienta tal como la ve el modelo (JSON Schema en `parametros`). */
export interface HerramientaDef {
  nombre: string;
  descripcion: string;
  parametros: Record<string, unknown>;
}

/** Ejecuta una herramienta y devuelve el resultado como texto para el modelo. */
export type EjecutarHerramienta = (nombre: string, argumentos: Record<string, unknown>) => Promise<string>;

export interface PeticionModelo {
  modelo: string;
  /** Instrucciones + base de conocimiento; se cachea como prefijo. */
  sistema: string;
  /** Conversación en orden cronológico; el último debe ser del usuario. */
  historial: { rol: "usuario" | "asistente"; texto: string }[];
  esfuerzo: "low" | "medium" | "high";
  maxSalida: number;
  herramientas?: HerramientaDef[];
  ejecutar?: EjecutarHerramienta;
}

export interface RespuestaModelo {
  /** null si el modelo no contestó (rechazo o sin texto). */
  texto: string | null;
  /** Modelo que sirvió de verdad (puede diferir si hubo fallback). */
  modelo: string;
  /** Sumado sobre todas las rondas de herramientas. */
  uso: Uso;
  /** null si el modelo no está en la tabla de precios: se registra igual. */
  costoUsd: number | null;
  parada: string | null;
  /** Herramientas invocadas en esta respuesta, en orden. */
  herramientasUsadas: string[];
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

/** Rondas máximas de herramientas por respuesta: evita bucles y acota el gasto. */
const RONDAS_MAX = 4;

/**
 * Falló una ronda, pero las anteriores ya gastaron: el error lleva ese uso
 * para que el agente lo registre. Si no, Billing mostraría menos que la
 * factura real de Anthropic.
 */
export class ErrorProveedor extends Error {
  constructor(readonly causa: unknown, readonly usoParcial: Uso, readonly modelo: string, readonly ronda: number) {
    super(causa instanceof Error ? causa.message : String(causa));
    this.name = "ErrorProveedor";
  }
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
    const mensajes: Anthropic.Beta.BetaMessageParam[] = (desde >= 0 ? p.historial.slice(desde) : []).map((h) => ({
      role: h.rol === "usuario" ? "user" : "assistant",
      content: h.texto,
    }));
    const herramientas: Anthropic.Beta.BetaTool[] = (p.herramientas ?? []).map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      input_schema: { type: "object" as const, ...h.parametros },
    }));
    const uso: Uso = { entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0 };
    const usadas: string[] = [];
    let modeloServido = p.modelo;
    let parada: string | null = null;

    for (let ronda = 0; ronda <= RONDAS_MAX; ronda += 1) {
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await this.#client.beta.messages.create({
        model: p.modelo,
        max_tokens: p.maxSalida,
        // Si un clasificador declina, el servidor reintenta en el modelo de respaldo dentro de la misma llamada.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: p.esfuerzo },
        system: [{ type: "text", text: p.sistema, cache_control: { type: "ephemeral" } }],
        ...(herramientas.length ? { tools: herramientas } : {}),
        messages: mensajes,
        });
      } catch (err) {
        throw new ErrorProveedor(err, uso, modeloServido, ronda);
      }
      uso.entrada += res.usage.input_tokens;
      uso.salida += res.usage.output_tokens;
      uso.cacheLectura += res.usage.cache_read_input_tokens ?? 0;
      uso.cacheEscritura += res.usage.cache_creation_input_tokens ?? 0;
      modeloServido = res.model;
      parada = res.stop_reason ?? null;

      if (res.stop_reason === "refusal") {
        return { texto: null, modelo: modeloServido, uso, costoUsd: costoUsd(modeloServido, uso), parada, herramientasUsadas: usadas };
      }
      const pedidos = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || pedidos.length === 0 || !p.ejecutar) {
        const texto = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
        return { texto, modelo: modeloServido, uso, costoUsd: costoUsd(modeloServido, uso), parada, herramientasUsadas: usadas };
      }
      // Ejecutar TODAS las herramientas pedidas y devolverlas en UN solo mensaje.
      const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of pedidos) {
        usadas.push(t.name);
        let salida: string;
        let error = false;
        try {
          salida = await p.ejecutar(t.name, (t.input ?? {}) as Record<string, unknown>);
        } catch (err) {
          salida = `error: ${err instanceof Error ? err.message : String(err)}`;
          error = true;
        }
        resultados.push({ type: "tool_result", tool_use_id: t.id, content: salida, ...(error ? { is_error: true } : {}) });
      }
      mensajes.push({ role: "assistant", content: res.content });
      mensajes.push({ role: "user", content: resultados });
    }
    return { texto: null, modelo: modeloServido, uso, costoUsd: costoUsd(modeloServido, uso), parada: "rondas_agotadas", herramientasUsadas: usadas };
  }
}
