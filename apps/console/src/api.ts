import type { Instance, Message } from "@cauce/core";
export type { Instance, Message } from "@cauce/core";

/**
 * Único canal de la consola hacia el sistema: HTTP al orquestador.
 * Aquí no hay transportes ni Docker; la consola no sabe que existen.
 */

const BASE = (import.meta.env.VITE_CAUCE_API as string | undefined) ??
  "http://localhost:3001";

/**
 * Proveedor del ID token de Firebase (lo fija App tras el login). Cada
 * llamada lo pide fresco: Firebase rota el token y getIdToken() lo
 * refresca solo. La consola ya no maneja API keys.
 */
let proveedorToken: (() => Promise<string | null>) | null = null;
export function usarProveedorToken(p: (() => Promise<string | null>) | null) {
  proveedorToken = p;
}

async function llamar<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const token = proveedorToken ? await proveedorToken() : null;
  const res = await fetch(`${BASE}${ruta}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (res.status === 401) throw new ErrorNoAutorizado();
  if (!res.ok && res.status !== 202) {
    const cuerpo = await res.json().catch(() => null);
    throw new Error(cuerpo?.error ?? `error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}

export class ErrorNoAutorizado extends Error {
  constructor() {
    super("no autorizado");
  }
}

export interface Yo {
  tenantId: string;
  nombre: string;
  plan: "prueba" | "base" | "extras";
  limites: { lineas: number; conectores: number };
  pruebaExpiraEn: string | null;
  pruebaVigente: boolean;
}

export const api = {
  yo: () => llamar<Yo>("/api/me"),

  provisionar: () =>
    llamar<{ tenantId: string; nombre: string; plan: string; apiKey: string | null }>(
      "/api/provisionar",
      { method: "POST" },
    ),

  instancias: (tenantId: string) =>
    llamar<Instance[]>(`/api/tenants/${tenantId}/instances`),

  instancia: (tenantId: string, id: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances/${id}`),

  crearInstancia: (tenantId: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances`, { method: "POST" }),

  eliminarInstancia: (tenantId: string, id: string) =>
    llamar<void>(`/api/tenants/${tenantId}/instances/${id}`, {
      method: "DELETE",
    }),

  desconectarInstancia: (tenantId: string, id: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances/${id}/disconnect`, {
      method: "POST",
    }),

  reconectarInstancia: (tenantId: string, id: string) =>
    llamar<Instance>(`/api/tenants/${tenantId}/instances/${id}/connect`, {
      method: "POST",
    }),

  qr: async (tenantId: string, id: string) => {
    // El orquestador nuevo responde 200 con codigo:null cuando no hay QR
    // en este estado. Se tolera también el 404 del orquestador anterior
    // (rollout: la consola puede desplegarse antes que el orquestador).
    try {
      const qr = await llamar<{
        codigo: string | null;
        imagenBase64: string | null;
      }>(`/api/tenants/${tenantId}/instances/${id}/qr`);
      return qr.codigo ? qr : null;
    } catch (err) {
      if (err instanceof ErrorNoAutorizado) throw err;
      return null;
    }
  },

  mensajes: (tenantId: string, id: string) =>
    llamar<Message[]>(`/api/tenants/${tenantId}/instances/${id}/messages`),

  mensajesTenant: (tenantId: string) =>
    llamar<Message[]>(`/api/tenants/${tenantId}/messages`),

  enviar: (tenantId: string, id: string, telefono: string, cuerpo: string) =>
    llamar<{ id: string; estado: string }>(
      `/api/tenants/${tenantId}/instances/${id}/send`,
      { method: "POST", body: JSON.stringify({ telefono, cuerpo }) },
    ),

  // ---- Conexiones (monday) ----
  monday: {
    ver: (tenantId: string) =>
      llamar<MondayVista | null>(`/api/tenants/${tenantId}/conectores/monday`),

    probar: (tenantId: string, apiToken: string) =>
      llamar<{ ok: boolean; boards: MondayBoard[] }>(
        `/api/tenants/${tenantId}/conectores/monday/probar`,
        { method: "POST", body: JSON.stringify({ apiToken }) },
      ),

    columnas: (tenantId: string, apiToken: string, boardId: string) =>
      llamar<MondayColumna[]>(
        `/api/tenants/${tenantId}/conectores/monday/columnas`,
        { method: "POST", body: JSON.stringify({ apiToken, boardId }) },
      ),

    guardar: (tenantId: string, alta: MondayAlta) =>
      llamar<void>(`/api/tenants/${tenantId}/conectores/monday`, {
        method: "PUT",
        body: JSON.stringify(alta),
      }),

    columnasGuardadas: (tenantId: string) =>
      llamar<MondayColumna[]>(
        `/api/tenants/${tenantId}/conectores/monday/board-columnas`,
      ),

    quitar: (tenantId: string) =>
      llamar<void>(`/api/tenants/${tenantId}/conectores/monday`, {
        method: "DELETE",
      }),

    registro: (tenantId: string) =>
      llamar<RegistroMonday>(
        `/api/tenants/${tenantId}/conectores/monday/registro`,
      ),

    guardarPlantilla: (tenantId: string, plantilla: string) =>
      llamar<void>(`/api/tenants/${tenantId}/conectores/monday/plantilla`, {
        method: "PUT",
        body: JSON.stringify({ plantilla }),
      }),
  },

  // ---- Acciones entrantes (disparadores) ----
  disparadores: (tenantId: string) =>
    llamar<Disparador[]>(`/api/tenants/${tenantId}/disparadores`),

  guardarDisparadores: (tenantId: string, lista: Disparador[]) =>
    llamar<void>(`/api/tenants/${tenantId}/disparadores`, {
      method: "PUT",
      body: JSON.stringify(lista),
    }),
};

export interface MondayBoard {
  id: string;
  name: string;
}
export interface MondayColumna {
  id: string;
  title: string;
  type: string;
}
export interface MondayVista {
  instanceId: string;
  boardId: string;
  boardNombre: string;
  columnaTelefono: string;
  plantilla: string;
  apiTokenPista: string;
  tieneSigningSecret: boolean;
}
export interface MondayAlta {
  instanceId: string;
  boardId: string;
  boardNombre: string;
  apiToken: string;
  signingSecret: string;
  columnaTelefono: string;
  plantilla: string;
}

/** Tipos de columna de monday válidos para mapear como teléfono. */
export const TIPOS_TELEFONO = ["phone", "text"];
/** Tipos cuyo texto es útil como variable de plantilla. */
export const TIPOS_VARIABLE = [
  "phone", "text", "long-text", "numbers", "numeric",
  "date", "email", "name", "status", "dropdown", "location", "link",
];
export function columnaEsTelefono(tipo: string): boolean {
  return TIPOS_TELEFONO.includes(tipo);
}
export function columnaEsVariable(tipo: string): boolean {
  return TIPOS_VARIABLE.includes(tipo);
}

export interface RegistroMonday {
  ultimaLlamadaEn: string | null;
  ultimoResultado:
    | { ok: true; itemId: string; telefono: string; en: string }
    | { ok: false; error: string; en: string }
    | null;
}

export type TipoDisparador =
  | "primer_contacto"
  | "palabra_clave"
  | "cualquiera"
  | "fuera_horario";

export interface Disparador {
  id: string;
  prioridad: number;
  tipo: TipoDisparador;
  activo: boolean;
  respuesta: string;
  patron?: string;
  coincidencia?: "contiene" | "igual";
  horario?: { tz: string; dias: number[]; desde: string; hasta: string };
}

/** URL del webhook de monday que el usuario pega en la automatización. */
export function urlWebhookMonday(tenantId: string): string {
  return `${BASE}/webhooks/monday/${tenantId}`;
}
