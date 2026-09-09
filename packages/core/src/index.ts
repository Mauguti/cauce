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
   * ISO 8601 de cuándo el usuario aceptó las condiciones de uso del
   * número (sesión no oficial, no prospección en frío). Null/ausente =
   * aún no las acepta; se le muestran al conectar su primer número.
   */
  terminosAceptadosEn?: string | null;
  /**
   * Milisegundos entre envíos de la cola de cada instancia del tenant
   * (antes del jitter). Ausente = valor por defecto conservador.
   */
  envioIntervaloMs?: number;
  /**
   * ISO 8601 de las últimas creaciones de sesión (buffer acotado). Sirve
   * para detectar churn: crear y borrar el mismo número en ráfaga deja
   * claves Signal viejas que degradan el número. Ver `churnReciente`.
   */
  sesionesRecientes?: string[];
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

/** Ventana y umbral para considerar que un tenant está haciendo churn. */
export const CHURN_VENTANA_MS = 30 * 60_000;
export const CHURN_UMBRAL = 3;
/** Cuántas marcas de creación de sesión se conservan por tenant. */
export const SESIONES_RECIENTES_MAX = 20;

/**
 * ¿El tenant creó sesiones en ráfaga hace poco? Crear y borrar el mismo
 * número una y otra vez es lo que lo degrada; con esto la consola avisa
 * antes de recrear. True si hubo >= CHURN_UMBRAL creaciones dentro de la
 * ventana.
 */
export function churnReciente(t: Tenant, ahora: Date = new Date()): boolean {
  const desde = ahora.getTime() - CHURN_VENTANA_MS;
  const recientes = (t.sesionesRecientes ?? []).filter(
    (iso) => new Date(iso).getTime() >= desde,
  );
  return recientes.length >= CHURN_UMBRAL;
}

/** Agrega una marca de creación de sesión, acotando el buffer. */
export function registrarCreacionSesion(
  t: Tenant,
  ahora: Date = new Date(),
): string[] {
  return [...(t.sesionesRecientes ?? []), ahora.toISOString()].slice(
    -SESIONES_RECIENTES_MAX,
  );
}

/**
 * Un `enviado` sin confirmación pasado este tiempo se considera
 * `no_confirmado`. El SERVER_ACK de WhatsApp llega en segundos; tres
 * minutos sin él es señal fuerte de que no salió.
 */
export const UMBRAL_SIN_CONFIRMAR_MS = 3 * 60_000;

/**
 * ¿Este saliente aceptado por el transporte lleva demasiado sin que
 * Evolution confirme su entrega? Solo aplica a `enviado` sin confirmar.
 */
export function envioSinConfirmar(
  m: Message,
  ahora: Date = new Date(),
  umbralMs: number = UMBRAL_SIN_CONFIRMAR_MS,
): boolean {
  if (m.direccion !== "out" || m.estado !== "enviado" || m.confirmadoEn) {
    return false;
  }
  return ahora.getTime() - new Date(m.timestamp).getTime() >= umbralMs;
}

/** Cuántos salientes sin confirmar seguidos delatan una sesión degradada. */
export const SESION_DEGRADADA_UMBRAL = 3;

/**
 * ¿La sesión parece degradada? Mira los salientes recientes de una
 * instancia (los que ya se intentaron: enviado/no_confirmado/fallido) y
 * es cierto si al menos UMBRAL de los más recientes quedaron sin
 * confirmar. Es justo el patrón del bug PENDING: Cauce acepta el envío y
 * WhatsApp nunca lo entrega.
 */
export function sesionPareceDegradada(
  mensajes: Message[],
  umbral: number = SESION_DEGRADADA_UMBRAL,
): boolean {
  const salientes = mensajes.filter((m) => m.direccion === "out");
  // Calibración: "no confirmado" solo es evidencia de degradación si el
  // canal de confirmación (MESSAGES_UPDATE/SERVER_ACK) demostrablemente
  // funciona para esta instancia — es decir, si ALGÚN saliente llegó a
  // confirmarse. Si NUNCA se confirmó nada, la ausencia de confirmación
  // apunta a la tubería (webhook mal registrado, evento suprimido), no a
  // un número quemado; en ese caso no afirmamos degradación (evita el
  // falso positivo que manda a desconectar un número sano).
  const algunaVezConfirmado = salientes.some((m) => Boolean(m.confirmadoEn));
  if (!algunaVezConfirmado) return false;

  const intentados = salientes
    .filter(
      (m) =>
        m.estado === "enviado" ||
        m.estado === "no_confirmado" ||
        m.estado === "fallido",
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, Math.max(umbral, 5));
  if (intentados.length < umbral) return false;
  const sinConfirmar = intentados.filter(
    (m) => m.estado === "no_confirmado",
  ).length;
  return sinConfirmar >= umbral;
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
 * `enviado` significa que el transporte lo aceptó (201), NO que WhatsApp
 * lo entregó. Si tras un rato Evolution no confirma la entrega
 * (SERVER_ACK), pasa a `no_confirmado`: señal de que la sesión puede
 * estar degradada (el bug PENDING de Evolution/Baileys). Los entrantes
 * nacen y mueren en `recibido`.
 */
export type MessageEstado =
  | "encolado"
  | "enviando"
  | "enviado"
  | "no_confirmado"
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
  /**
   * Causa del fallo (solo cuando estado = "fallido"): motivo entendible
   * para el operador, listo para mostrar en el registro de envíos.
   */
  error?: string | null;
  /** Código de la causa, para decidir en la UI si el reintento aplica. */
  errorCodigo?: FalloEnvio | null;
  /**
   * ISO 8601 de cuándo Evolution confirmó la entrega (SERVER_ACK o más).
   * Null/ausente = aún sin confirmar. Distingue "aceptado por el
   * transporte" de "entregado de verdad".
   */
  confirmadoEn?: string | null;
  /** ISO 8601 */
  timestamp: string;
}

/**
 * Causas distinguibles de un envío fallido. `reintentable` en la UI se
 * decide por código: p. ej. una columna vacía no se corrige reintentando
 * el mismo mensaje, sino arreglando el item.
 */
export type FalloEnvio =
  | "sesion_desconectada"
  | "telefono_vacio"
  | "telefono_invalido"
  | "item_incompleto"
  | "transporte_rechazo"
  | "desconocido";

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
  /**
   * Nombre visible del contacto (pushName de WhatsApp), capturado del
   * primer/último entrante. Da contexto en el registro en vez del número
   * crudo. Null/ausente hasta que el contacto escribe.
   */
  nombre?: string | null;
  /** ISO del primer mensaje entrante; null si aún no ha escrito. */
  primerContactoEn: string | null;
  /** ISO del último mensaje entrante; null si aún no ha escrito. */
  ultimoEntranteEn: string | null;
  /** Item de monday que originó/recibe esta conversación; null si ninguno. */
  mondayItemId: string | null;
  /**
   * Entidad de Bitrix24 (deal/contact/…) que originó/recibe esta
   * conversación; null si ninguna. La respuesta del cliente vuelve a su
   * timeline. Análogo a `mondayItemId` para el otro CRM.
   */
  bitrixEntidad?: { tipo: string; id: string } | null;
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
