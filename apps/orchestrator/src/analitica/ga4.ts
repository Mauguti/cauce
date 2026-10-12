import { registrar, registrarError } from "../log.ts";

/**
 * Conversiones a GA4 por el Protocolo de Medición, desde el servidor.
 *
 * Por qué desde aquí y no desde el navegador: el `success_url` del
 * Checkout no sirve para medir (el cliente paga y puede cerrar la
 * pestaña); la conversión real la cuenta el webhook de Stripe. Y el
 * `client_id` de GA4 (cookie `_ga`) solo existe en el navegador en el
 * momento de crear la sesión: el front lo manda, se guarda en la metadata
 * de la sesión y de la suscripción, y el webhook lo usa después.
 *
 * Bandera: sin GA4_MEASUREMENT_ID y GA4_API_SECRET no se manda nada y se
 * dice en el arranque. Nunca lanza: una falla de medición no puede tirar
 * un webhook de cobro.
 */
export interface Analitica {
  readonly activa: boolean;
  evento(clientId: string | null | undefined, nombre: EventoConversion, params: Record<string, string | number>): Promise<void>;
}

export type EventoConversion = "checkout_iniciado" | "prueba_iniciada" | "suscripcion_activa";

/** `_ga` = "GA1.1.123456789.1700000000" → client_id "123456789.1700000000". Acepta ya el client_id limpio. */
export function clientIdDeCookie(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const v = valor.trim();
  const m = v.match(/(\d+\.\d+)$/);
  return m && /^\d+\.\d+$/.test(m[1]!) && m[1]!.length <= 64 ? m[1]! : null;
}

export class GA4Real implements Analitica {
  readonly activa = true;
  readonly #measurementId: string;
  readonly #apiSecret: string;
  readonly #fetch: typeof fetch;

  constructor(o: { measurementId: string; apiSecret: string; fetchImpl?: typeof fetch }) {
    this.#measurementId = o.measurementId;
    this.#apiSecret = o.apiSecret;
    this.#fetch = o.fetchImpl ?? fetch;
  }

  async evento(clientId: string | null | undefined, nombre: EventoConversion, params: Record<string, string | number>): Promise<void> {
    const cid = clientIdDeCookie(clientId);
    if (!cid) {
      registrar("ga4.sin_client_id", { evento: nombre, ...params }, "warn");
      return;
    }
    try {
      const res = await this.#fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(this.#measurementId)}&api_secret=${encodeURIComponent(this.#apiSecret)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: cid, non_personalized_ads: true, events: [{ name: nombre, params }] }),
        signal: AbortSignal.timeout(5_000),
      });
      // El endpoint responde 2xx aunque el evento sea inválido; el detalle solo lo da /debug/mp/collect.
      registrar("ga4.enviado", { evento: nombre, status: res.status, ...params }, res.ok ? "info" : "warn");
    } catch (err) {
      registrarError("ga4.error", err, { evento: nombre, ...params });
    }
  }
}

/** Sin configuración: no manda nada, no registra por evento (ya se avisó en el arranque). */
export const ANALITICA_APAGADA: Analitica = { activa: false, async evento() {} };
