import type { ConectorGoogleDoc, TenantId } from "@cauce/core";
import type { Repositorio } from "../store.ts";
import type { Cripto } from "../cripto.ts";
import { registrar, registrarError } from "../log.ts";

/**
 * Google Calendar por tenant con OAuth (decisión 16-sep-2026): un clic
 * "Conectar Google" en Integraciones, refresh token cifrado por tenant,
 * revocable por el cliente desde su cuenta. Scope mínimo: `calendar.events`
 * (leer y escribir eventos; con eso se lista, se inserta, se borra y se
 * obtiene la zona horaria del calendario, que viene en events.list).
 * Ni cuenta de servicio (excluye Gmail personal) ni calendarios
 * compartidos a una cuenta nuestra (un solo secreto que compromete a
 * todos los clientes).
 */

export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";

export interface EventoCalendario {
  id: string;
  /** ISO. */
  inicio: string;
  fin: string;
  titulo: string;
  descripcion: string | null;
  /** extendedProperties.private, donde guardamos el teléfono de quien agendó. */
  privado: Record<string, string>;
  estado: "confirmed" | "tentative" | "cancelled";
  /** true si el evento es de "todo el día" (bloquea el día completo). */
  todoElDia: boolean;
}

export interface ClienteCalendario {
  /** Eventos del rango (instancias expandidas) y la zona horaria del calendario. */
  eventos(tenantId: TenantId, calendarioId: string, desdeIso: string, hastaIso: string): Promise<{ zona: string; eventos: EventoCalendario[] }>;
  insertar(tenantId: TenantId, calendarioId: string, e: { inicio: string; fin: string; titulo: string; descripcion: string; privado: Record<string, string> }): Promise<EventoCalendario>;
  borrar(tenantId: TenantId, calendarioId: string, eventoId: string): Promise<void>;
  mover(tenantId: TenantId, calendarioId: string, eventoId: string, inicio: string, fin: string): Promise<EventoCalendario>;
}

export interface OpcionesGoogle {
  clientId: string;
  clientSecret: string;
  /** https://api.factory.digsol.com.mx/google/callback */
  redirectUri: string;
}

export class ErrorGoogle extends Error {
  readonly status: number;
  constructor(status: number, mensaje: string) {
    super(mensaje);
    this.name = "ErrorGoogle";
    this.status = status;
  }
}

/** OAuth + Calendar contra la API real. Tokens de acceso en memoria por tenant. */
export class GoogleReal implements ClienteCalendario {
  readonly #o: OpcionesGoogle;
  readonly #repo: Repositorio;
  readonly #cripto: Cripto;
  readonly #fetch: typeof fetch;
  #acceso = new Map<TenantId, { token: string; vence: number }>();

  constructor(opciones: OpcionesGoogle & { repo: Repositorio; cripto: Cripto; fetchImpl?: typeof fetch }) {
    this.#o = opciones;
    this.#repo = opciones.repo;
    this.#cripto = opciones.cripto;
    this.#fetch = opciones.fetchImpl ?? fetch;
  }

  /** URL a la que se manda al cliente. `state` va cifrado con el tenant y una caducidad. */
  urlAutorizacion(tenantId: TenantId): string {
    const state = this.#cripto.cifrar(JSON.stringify({ t: tenantId, exp: Date.now() + 15 * 60_000 }));
    const q = new URLSearchParams({
      client_id: this.#o.clientId,
      redirect_uri: this.#o.redirectUri,
      response_type: "code",
      scope: `${SCOPE_CALENDAR} ${SCOPE_EMAIL}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  /** Callback: valida el state, cambia el código por tokens y guarda el refresh token cifrado. Devuelve el tenant. */
  async completarConexion(code: string, state: string): Promise<{ tenantId: TenantId; email: string | null }> {
    let datos: { t: string; exp: number };
    try {
      datos = JSON.parse(this.#cripto.descifrar(state));
    } catch {
      throw new ErrorGoogle(400, "state inválido");
    }
    if (!datos.t || datos.exp < Date.now()) throw new ErrorGoogle(400, "la autorización caducó; vuelve a intentar desde Integraciones");
    const res = await this.#fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.#o.clientId, client_secret: this.#o.clientSecret, redirect_uri: this.#o.redirectUri, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    const cuerpo: any = await res.json().catch(() => ({}));
    if (!res.ok || !cuerpo.refresh_token) {
      registrar("google.oauth_error", { tenant: datos.t, status: res.status, error: cuerpo.error ?? null, sinRefresh: !cuerpo.refresh_token }, "warn");
      throw new ErrorGoogle(502, cuerpo.refresh_token ? `Google respondió ${res.status}` : "Google no entregó refresh token; revoca el acceso en tu cuenta de Google y vuelve a conectar");
    }
    let email: string | null = null;
    try {
      const yo = await this.#fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${cuerpo.access_token}` }, signal: AbortSignal.timeout(10_000) });
      email = ((await yo.json()) as any)?.email ?? null;
    } catch { /* el correo es informativo */ }
    await this.#repo.saveConectorGoogle(datos.t, { email, refreshTokenCifrado: this.#cripto.cifrar(String(cuerpo.refresh_token)), scope: String(cuerpo.scope ?? SCOPE_CALENDAR), conectadoEn: new Date().toISOString() });
    this.#acceso.set(datos.t, { token: String(cuerpo.access_token), vence: Date.now() + (Number(cuerpo.expires_in ?? 3600) - 60) * 1000 });
    registrar("google.conectado", { tenant: datos.t, email, scope: cuerpo.scope ?? null });
    return { tenantId: datos.t, email };
  }

  async desconectar(tenantId: TenantId): Promise<void> {
    const doc = await this.#repo.getConectorGoogle(tenantId);
    if (doc) {
      try {
        await this.#fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(this.#cripto.descifrar(doc.refreshTokenCifrado))}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        registrarError("google.revocar", err, { tenant: tenantId });
      }
    }
    await this.#repo.deleteConectorGoogle(tenantId);
    this.#acceso.delete(tenantId);
    registrar("google.desconectado", { tenant: tenantId });
  }

  async #token(tenantId: TenantId): Promise<string> {
    const vivo = this.#acceso.get(tenantId);
    if (vivo && vivo.vence > Date.now()) return vivo.token;
    const doc: ConectorGoogleDoc | null = await this.#repo.getConectorGoogle(tenantId);
    if (!doc) throw new ErrorGoogle(409, "Google Calendar no está conectado");
    const res = await this.#fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ refresh_token: this.#cripto.descifrar(doc.refreshTokenCifrado), client_id: this.#o.clientId, client_secret: this.#o.clientSecret, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    const cuerpo: any = await res.json().catch(() => ({}));
    if (!res.ok || !cuerpo.access_token) {
      registrar("google.token_error", { tenant: tenantId, status: res.status, error: cuerpo.error ?? null }, "error");
      throw new ErrorGoogle(502, cuerpo.error === "invalid_grant" ? "Google revocó el acceso; vuelve a conectar el calendario" : `Google respondió ${res.status}`);
    }
    const token = String(cuerpo.access_token);
    this.#acceso.set(tenantId, { token, vence: Date.now() + (Number(cuerpo.expires_in ?? 3600) - 60) * 1000 });
    return token;
  }

  async #api<T>(tenantId: TenantId, metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const token = await this.#token(tenantId);
    const res = await this.#fetch(`https://www.googleapis.com/calendar/v3${ruta}`, {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, ...(cuerpo ? { "content-type": "application/json" } : {}) },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return undefined as T;
    const datos: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      registrar("google.api_error", { tenant: tenantId, metodo, ruta: ruta.split("?")[0], status: res.status, error: datos?.error?.message ?? null }, "warn");
      throw new ErrorGoogle(res.status === 404 ? 404 : 502, datos?.error?.message ?? `Google respondió ${res.status}`);
    }
    return datos as T;
  }

  async eventos(tenantId: TenantId, calendarioId: string, desdeIso: string, hastaIso: string): Promise<{ zona: string; eventos: EventoCalendario[] }> {
    const q = new URLSearchParams({ timeMin: desdeIso, timeMax: hastaIso, singleEvents: "true", orderBy: "startTime", maxResults: "250", showDeleted: "false" });
    const r = await this.#api<any>(tenantId, "GET", `/calendars/${encodeURIComponent(calendarioId)}/events?${q}`);
    return { zona: String(r.timeZone ?? "America/Mexico_City"), eventos: (r.items ?? []).map(normalizarEvento).filter(Boolean) as EventoCalendario[] };
  }

  async insertar(tenantId: TenantId, calendarioId: string, e: { inicio: string; fin: string; titulo: string; descripcion: string; privado: Record<string, string> }): Promise<EventoCalendario> {
    const r = await this.#api<any>(tenantId, "POST", `/calendars/${encodeURIComponent(calendarioId)}/events`, {
      summary: e.titulo, description: e.descripcion, start: { dateTime: e.inicio }, end: { dateTime: e.fin }, extendedProperties: { private: e.privado },
    });
    return normalizarEvento(r)!;
  }

  async borrar(tenantId: TenantId, calendarioId: string, eventoId: string): Promise<void> {
    await this.#api<void>(tenantId, "DELETE", `/calendars/${encodeURIComponent(calendarioId)}/events/${encodeURIComponent(eventoId)}`);
  }

  async mover(tenantId: TenantId, calendarioId: string, eventoId: string, inicio: string, fin: string): Promise<EventoCalendario> {
    const r = await this.#api<any>(tenantId, "PATCH", `/calendars/${encodeURIComponent(calendarioId)}/events/${encodeURIComponent(eventoId)}`, { start: { dateTime: inicio }, end: { dateTime: fin } });
    return normalizarEvento(r)!;
  }
}

function normalizarEvento(r: any): EventoCalendario | null {
  if (!r?.id) return null;
  const todoElDia = Boolean(r.start?.date && !r.start?.dateTime);
  const inicio = r.start?.dateTime ?? (r.start?.date ? `${r.start.date}T00:00:00Z` : null);
  const fin = r.end?.dateTime ?? (r.end?.date ? `${r.end.date}T00:00:00Z` : null);
  if (!inicio || !fin) return null;
  return {
    id: String(r.id),
    inicio: new Date(inicio).toISOString(),
    fin: new Date(fin).toISOString(),
    titulo: String(r.summary ?? "(sin título)"),
    descripcion: r.description ? String(r.description) : null,
    privado: (r.extendedProperties?.private ?? {}) as Record<string, string>,
    estado: (r.status ?? "confirmed") as EventoCalendario["estado"],
    todoElDia,
  };
}
