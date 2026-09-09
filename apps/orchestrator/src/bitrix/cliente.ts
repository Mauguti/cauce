/**
 * Cliente REST de Bitrix24 sobre un WEBHOOK ENTRANTE (inbound webhook):
 * una URL con un token estático embebido
 * (`https://<portal>.bitrix24.com/rest/<user>/<code>/`) que autoriza
 * llamadas REST sin OAuth. Es el equivalente exacto del API token de
 * monday: el cliente lo pega, Cauce lo cifra en reposo y lo usa para leer
 * la entidad y escribir en su timeline. (Ver docs/adr / reporte del bloque
 * 15 para por qué webhook y no OAuth.)
 */

/** Entidades de CRM que soportamos (mismas claves que usa el timeline). */
export type EntidadBitrix = "deal" | "contact" | "lead" | "company";

export interface CampoBitrix {
  id: string;
  title: string;
  type: string;
}

export interface RegistroBitrix {
  id: string;
  /** Nombre visible del registro (título del deal, nombre del contacto…). */
  nombre: string;
  /** Todos los campos crudos, para resolver variables y el teléfono. */
  campos: Record<string, unknown>;
}

/**
 * Normaliza la URL de un webhook entrante a la base REST con una sola
 * barra final: `https://<dominio>/rest/<id>/<token>/`.
 *
 * Bitrix muestra dos formas en la misma pantalla y cualquiera pega
 * cualquiera de ellas:
 *   .../rest/1/token/              (webhook para llamar a la API REST)
 *   .../rest/1/token/profile.json  (generador de solicitudes, la más visible)
 * Además pueden pegarla sin barra final. Se quita cualquier segmento final
 * `<algo>.json` y las diagonales sobrantes, de modo que las tres formas
 * produzcan la misma base y `<metodo>.json` se concatene bien.
 */
export function normalizarWebhookBitrix(webhookUrl: string): string {
  const base = webhookUrl
    .trim()
    .replace(/[?#].*$/, "") // por si viene con query/fragmento
    .replace(/\/[^/]+\.json\/*$/i, "") // quita /profile.json (o cualquier método) final
    .replace(/\/+$/, ""); // quita diagonales sobrantes
  return base + "/";
}

export class ClienteBitrix {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(webhookUrl: string, opciones: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.#base = normalizarWebhookBitrix(webhookUrl);
    this.#fetch = opciones.fetchImpl ?? fetch;
    this.#timeoutMs = opciones.timeoutMs ?? 15_000;
  }

  async #llamar(metodo: string, params: unknown): Promise<any> {
    const res = await this.#fetch(`${this.#base}${metodo}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // Bitrix a veces responde error sin JSON; se reporta por status.
    }
    if (res.status >= 400 || json?.error) {
      const detalle = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
      // "Method not found" casi siempre es una URL mal formada (un método
      // pegado en la base), no un problema de permisos: dirige a revisar la
      // URL, no la lista de permisos.
      const esMetodo = /method not found|not found/i.test(String(detalle));
      const pista = esMetodo
        ? "Revisa que pegaste la URL del webhook ENTRANTE completa (termina en /rest/<id>/<token>/), no la del generador de solicitudes ni un método suelto."
        : "Revisa la URL del webhook y que tenga permiso de CRM en Bitrix.";
      throw new Error(`Bitrix no aceptó la llamada (${metodo}): ${detalle}. ${pista}`);
    }
    return json?.result;
  }

  /** Valida el webhook llamando a un método sin scope (perfil del usuario). */
  async validar(): Promise<void> {
    await this.#llamar("profile", {});
  }

  /** Campos de una entidad (para mapear el teléfono y ofrecer variables). */
  async listarCampos(entidad: EntidadBitrix): Promise<CampoBitrix[]> {
    const result = await this.#llamar(`crm.${entidad}.fields`, {});
    return Object.entries(result ?? {}).map(([id, def]: [string, any]) => ({
      id,
      title: typeof def?.title === "string" ? def.title : id,
      type: typeof def?.type === "string" ? def.type : "string",
    }));
  }

  /** Lee una entidad por id. */
  async getRegistro(entidad: EntidadBitrix, id: string): Promise<RegistroBitrix | null> {
    const r = await this.#llamar(`crm.${entidad}.get`, { id });
    if (!r || typeof r !== "object") return null;
    return { id: String(r.ID ?? id), nombre: nombreDe(entidad, r), campos: r };
  }

  /** Publica un comentario en el timeline de la entidad (retorno al CRM). */
  async comentarTimeline(entidad: EntidadBitrix, id: string, comentario: string): Promise<void> {
    await this.#llamar("crm.timeline.comment.add", {
      fields: { ENTITY_ID: id, ENTITY_TYPE: entidad, COMMENT: comentario },
    });
  }
}

/** Nombre legible del registro según la entidad. */
function nombreDe(entidad: EntidadBitrix, r: any): string {
  if (entidad === "deal") return r.TITLE ?? `Deal ${r.ID ?? ""}`.trim();
  if (entidad === "company") return r.TITLE ?? `Empresa ${r.ID ?? ""}`.trim();
  const nombre = [r.NAME, r.LAST_NAME].filter(Boolean).join(" ").trim();
  return nombre || `Contacto ${r.ID ?? ""}`.trim();
}

/**
 * Texto de un campo del registro, resolviendo el formato multifield de
 * Bitrix (PHONE/EMAIL son arreglos [{VALUE, VALUE_TYPE}]). "" si no hay.
 */
export function valorCampo(campos: Record<string, unknown>, clave: string): string {
  const v = campos[clave];
  if (v == null) return "";
  if (Array.isArray(v)) {
    const primero: any = v[0];
    if (primero && typeof primero === "object" && "VALUE" in primero) {
      return String((primero as any).VALUE ?? "");
    }
    return primero == null ? "" : String(primero);
  }
  if (typeof v === "object" && "VALUE" in (v as any)) return String((v as any).VALUE ?? "");
  return String(v);
}
