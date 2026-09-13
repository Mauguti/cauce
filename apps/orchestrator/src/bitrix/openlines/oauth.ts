import type { TokensOAuth } from "./tipos.ts";

/**
 * OAuth de una aplicación local de Bitrix24.
 *
 * Al instalar, Bitrix manda ONAPPINSTALL con `auth` (access_token,
 * refresh_token, expires_in, client_endpoint, domain, member_id,
 * application_token). El access token dura ~1 h; se renueva con el
 * refresh token contra el servidor OAuth central de Bitrix. client_id y
 * client_secret NUNCA se guardan en el repo: llegan por entorno/secretos.
 */
export const OAUTH_BITRIX_URL = "https://oauth.bitrix.info/oauth/token/";

/** Margen antes de la caducidad para renovar sin carreras. */
const MARGEN_MS = 60_000;

export interface CredencialesApp {
  clientId: string;
  clientSecret: string;
}

/** Convierte el bloque `auth` de un evento/instalación de Bitrix a nuestros tokens. */
export function tokensDesdeAuth(auth: any, ahora: number = Date.now()): TokensOAuth {
  const requeridos = ["access_token", "refresh_token", "client_endpoint", "domain", "member_id", "application_token"];
  for (const k of requeridos) {
    if (typeof auth?.[k] !== "string" || auth[k].length === 0) {
      throw new Error(`auth de Bitrix incompleto: falta ${k}`);
    }
  }
  const expiresIn = Number(auth.expires_in);
  return {
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    expiraEn: ahora + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    clientEndpoint: String(auth.client_endpoint).replace(/\/+$/, "") + "/",
    dominio: auth.domain,
    memberId: auth.member_id,
    applicationToken: auth.application_token,
  };
}

export function tokenVigente(t: TokensOAuth, ahora: number = Date.now()): boolean {
  return t.expiraEn - MARGEN_MS > ahora;
}

/** Renueva el access token. Devuelve tokens nuevos; conserva endpoint, dominio y application_token. */
export async function refrescarTokens(
  t: TokensOAuth,
  cred: CredencialesApp,
  opciones: { fetchImpl?: typeof fetch; ahora?: number } = {},
): Promise<TokensOAuth> {
  const f = opciones.fetchImpl ?? fetch;
  const url = new URL(OAUTH_BITRIX_URL);
  url.searchParams.set("grant_type", "refresh_token");
  url.searchParams.set("client_id", cred.clientId);
  url.searchParams.set("client_secret", cred.clientSecret);
  url.searchParams.set("refresh_token", t.refreshToken);
  const res = await f(url.toString(), { method: "GET", signal: AbortSignal.timeout(15_000) });
  let json: any = null;
  try { json = await res.json(); } catch { /* sin JSON: se reporta por status */ }
  if (res.status >= 400 || json?.error || typeof json?.access_token !== "string") {
    throw new Error(`Bitrix OAuth no renovó el token: ${json?.error_description ?? json?.error ?? `HTTP ${res.status}`}`);
  }
  const ahora = opciones.ahora ?? Date.now();
  const expiresIn = Number(json.expires_in);
  return {
    ...t,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : t.refreshToken,
    expiraEn: ahora + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    ...(typeof json.client_endpoint === "string" ? { clientEndpoint: String(json.client_endpoint).replace(/\/+$/, "") + "/" } : {}),
  };
}
