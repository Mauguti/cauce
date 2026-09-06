/**
 * Modelo de datos de Cauce.
 *
 * Regla de multitenancy (ver docs/adr/0002): todo documento vive bajo
 * `tenants/{tenantId}` y todo tipo que sale de una colección carga su
 * `tenantId`. Ninguna consulta se hace sin él.
 */

export type TenantId = string;
export type InstanceId = string;
export type MessageId = string;

/**
 * Planes (ver bloque 8). `prueba` caduca; `base` es el pago mínimo;
 * `extras` lleva límites contratados explícitos.
 */
export type TenantPlan = "prueba" | "base" | "extras";
export type TenantEstado = "activo" | "suspendido";

/** Documento en `tenants/{tenantId}` */
export interface Tenant {
  id: TenantId;
  nombre: string;
  plan: TenantPlan;
  estado: TenantEstado;
  /**
   * SHA-256 (hex) de la API key del tenant. La key en claro nunca se
   * guarda; el tenant se deriva de la key presentada, no del path.
   */
  apiKeyHash: string;
  /** Máximo de líneas (instancias). Ausente → según plan. */
  limiteLineas?: number;
  /** Máximo de conectores CRM. Ausente → según plan. */
  limiteConectores?: number;
  /**
   * Fin de la prueba (ISO 8601). Solo aplica al plan `prueba`;
   * null/ausente = sin caducidad.
   */
  pruebaExpiraEn?: string | null;
  /**
   * Milisegundos entre envíos de la cola de cada instancia del tenant
   * (antes del jitter). Ausente = valor por defecto conservador.
   */
  envioIntervaloMs?: number;
  /** ISO 8601 */
  creadoEn: string;
}

/** Límites por plan. `extras` se sobreescribe con los campos del tenant. */
export const LIMITES_PLAN: Record<
  TenantPlan,
  { lineas: number; conectores: number }
> = {
  prueba: { lineas: 1, conectores: 1 },
  base: { lineas: 1, conectores: 1 },
  extras: { lineas: 99, conectores: 99 },
};

/** Duración de la prueba, en días. */
export const DIAS_PRUEBA = 14;

/** Límites efectivos del tenant (campos explícitos o los del plan). */
export function limitesTenant(t: Tenant): {
  lineas: number;
  conectores: number;
} {
  return {
    lineas: t.limiteLineas ?? LIMITES_PLAN[t.plan].lineas,
    conectores: t.limiteConectores ?? LIMITES_PLAN[t.plan].conectores,
  };
}

/** ¿El tenant está vigente? Falso solo si su prueba ya caducó. */
export function pruebaVigente(t: Tenant, ahora: Date = new Date()): boolean {
  if (t.plan !== "prueba" || !t.pruebaExpiraEn) return true;
  return ahora < new Date(t.pruebaExpiraEn);
}

/**
 * Ciclo de vida de una sesión de mensajería:
 * pending → qr → connected → disconnected (y de vuelta a qr al re-escanear).
 */
export type InstanceEstado = "pending" | "qr" | "connected" | "disconnected";

/**
 * Identificador de la implementación de transporte (ver docs/adr/0001).
 */
export type TransportType = "mock" | "evolution";

/** Documento en `tenants/{tenantId}/instances/{instanceId}` */
export interface Instance {
  id: InstanceId;
  tenantId: TenantId;
  transportType: TransportType;
  /** Id del contenedor Docker que corre la sesión; null hasta aprovisionar. */
  contenedorId: string | null;
  /** Número conectado en formato E.164; null hasta que la sesión conecta. */
  numero: string | null;
  estado: InstanceEstado;
  /** ISO 8601 del último heartbeat recibido; null si nunca ha reportado. */
  ultimoHeartbeat: string | null;
}

export type MessageDireccion = "in" | "out";
/**
 * Ciclo de vida de un mensaje saliente:
 * encolado → enviando → enviado | fallido (tras agotar reintentos).
 * Los entrantes nacen y mueren en `recibido`.
 */
export type MessageEstado =
  | "encolado"
  | "enviando"
  | "enviado"
  | "fallido"
  | "recibido";

/** Documento en `tenants/{tenantId}/messages/{messageId}` */
export interface Message {
  id: MessageId;
  tenantId: TenantId;
  instanceId: InstanceId;
  direccion: MessageDireccion;
  /** Teléfono de la contraparte en formato E.164. */
  telefono: string;
  cuerpo: string;
  estado: MessageEstado;
  /** Id que asigna el transporte al mensaje; null hasta que lo confirma. */
  externalId: string | null;
  /** ISO 8601 */
  timestamp: string;
}

/**
 * Conversación con un número por instancia. Es la identidad estable de
 * la relación: sobrevive a que el contenedor se reinicie o se reescanee
 * el QR, porque no depende de la sesión sino del par (instancia, teléfono).
 * Aquí vive el vínculo con el CRM (antes suelto): la respuesta del
 * cliente sabe a qué item de monday volver mirando `mondayItemId`.
 */
export interface Conversacion {
  tenantId: TenantId;
  instanceId: InstanceId;
  /** Teléfono de la contraparte en E.164 sin '+' (sirve de doc id). */
  telefono: string;
  /** ISO del primer mensaje entrante; null si aún no ha escrito. */
  primerContactoEn: string | null;
  /** ISO del último mensaje entrante; null si aún no ha escrito. */
  ultimoEntranteEn: string | null;
  /** Item de monday que originó/recibe esta conversación; null si ninguno. */
  mondayItemId: string | null;
}

/**
 * Rutas de Firestore. Centralizarlas aquí hace imposible construir una
 * ruta a datos de un tenant sin pasar su id.
 */
export const rutas = {
  tenant: (tenantId: TenantId) => `tenants/${tenantId}`,
  instances: (tenantId: TenantId) => `tenants/${tenantId}/instances`,
  instance: (tenantId: TenantId, instanceId: InstanceId) =>
    `tenants/${tenantId}/instances/${instanceId}`,
  messages: (tenantId: TenantId) => `tenants/${tenantId}/messages`,
  message: (tenantId: TenantId, messageId: MessageId) =>
    `tenants/${tenantId}/messages/${messageId}`,
  conversaciones: (tenantId: TenantId, instanceId: InstanceId) =>
    `tenants/${tenantId}/instances/${instanceId}/conversaciones`,
  conversacion: (tenantId: TenantId, instanceId: InstanceId, telefono: string) =>
    `tenants/${tenantId}/instances/${instanceId}/conversaciones/${telefono}`,
} as const;
