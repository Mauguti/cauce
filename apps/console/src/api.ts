import type { Instance, Message } from "@cauce/core";

/**
 * Único canal de la consola hacia el sistema: HTTP al orquestador.
 * Aquí no hay transportes ni Docker; la consola no sabe que existen.
 */

const BASE = (import.meta.env.VITE_CAUCE_API as string | undefined) ??
  "http://localhost:3001";

const CLAVE_STORAGE = "cauce.apiKey";

export function apiKeyGuardada(): string | null {
  try {
    return localStorage.getItem(CLAVE_STORAGE);
  } catch {
    return null;
  }
}

export function guardarApiKey(key: string): void {
  try {
    localStorage.setItem(CLAVE_STORAGE, key);
  } catch {
    // Sin storage (modo privado): la sesión vive lo que viva la página.
  }
}

export function olvidarApiKey(): void {
  try {
    localStorage.removeItem(CLAVE_STORAGE);
  } catch {}
}

async function llamar<T>(
  ruta: string,
  init: RequestInit = {},
  key = apiKeyGuardada(),
): Promise<T> {
  const res = await fetch(`${BASE}${ruta}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(key ? { "x-api-key": key } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (res.status === 401) throw new ErrorNoAutorizado();
  if (!res.ok && res.status !== 202) {
    const cuerpo = await res.json().catch(() => null);
    throw new Error(cuerpo?.error ?? `error ${res.status}`);
  }
  return (await res.json()) as T;
}

export class ErrorNoAutorizado extends Error {
  constructor() {
    super("API key inválida");
  }
}

export interface Yo {
  tenantId: string;
  nombre: string;
}

export const api = {
  yo: (key: string) => llamar<Yo>("/api/me", {}, key),

  instancias: (tenantId: string) =>
    llamar<Instance[]>(`/api/tenants/${tenantId}/instances`),

  instancia: (tenantId: string, id: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances/${id}`),

  crearInstancia: (tenantId: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances`, { method: "POST" }),

  eliminarInstancia: async (tenantId: string, id: string) => {
    const res = await fetch(`${BASE}/api/tenants/${tenantId}/instances/${id}`, {
      method: "DELETE",
      headers: { "x-api-key": apiKeyGuardada() ?? "" },
    });
    if (!res.ok && res.status !== 204) throw new Error(`error ${res.status}`);
  },

  qr: async (tenantId: string, id: string) => {
    // El orquestador responde 200 con codigo:null cuando no hay QR en
    // este estado (aún generándose, o ya conectada); un 404 real sería
    // instancia inexistente y se propaga como error.
    const qr = await llamar<{
      codigo: string | null;
      imagenBase64: string | null;
    }>(`/api/tenants/${tenantId}/instances/${id}/qr`);
    return qr.codigo ? qr : null;
  },

  mensajes: (tenantId: string, id: string) =>
    llamar<Message[]>(`/api/tenants/${tenantId}/instances/${id}/messages`),

  enviar: (tenantId: string, id: string, telefono: string, cuerpo: string) =>
    llamar<{ id: string; estado: string }>(
      `/api/tenants/${tenantId}/instances/${id}/send`,
      { method: "POST", body: JSON.stringify({ telefono, cuerpo }) },
    ),
};
