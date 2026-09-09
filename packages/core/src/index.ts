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
 * Planes. Un plan define QUÉ PUEDE HACER el tenant (capacidades) y sus
 * límites por defecto. `prueba` caduca a los 14 días y cae a solo
 * lectura; `basico`, `estandar` y `pro` son los planes vendidos.
 *
 * Los ids antiguos `base` y `extras` ya no existen en el modelo: se
 * migran a `estandar` (extras además con límites por override). Mientras
 * la migración no haya corrido, `normalizarPlan` los traduce al leer, así
 * que el código nuevo funciona con datos viejos y viceversa nunca hace
 * falta.
 */
export type TenantPlan = "prueba" | "basico" | "estandar" | "pro";
export type TenantEstado = "activo" | "suspendido";

/**
 * Capacidades que un plan habilita:
 * - salientes: mensajes disparados desde el CRM (automatizaciones) y envíos manuales.
 * - entrantes: los mensajes que llegan se vinculan al CRM (write-back a monday/Bitrix).
 * - bots: respuestas automáticas a entrantes (disparadores: primer contacto, palabra clave…).
 * - agentes: agentes de IA.
 */
export type Capacidad = "salientes" | "entrantes" | "bots" | "agentes";

export interface DefinicionPlan {
  nombre: string;
  capacidades: readonly Capacidad[];
  /** Límites por defecto; `Tenant.limitesOverride` los sustituye. */
  limites: { lineas: number; conectores: number; agentes: number };
}

export const PLANES: Record<TenantPlan, DefinicionPlan> = {
  prueba: {
    nombre: "Prueba",
    // Lo mismo que Estándar, sin agentes: el agente consume API real desde el primer mensaje.
    capacidades: ["salientes", "entrantes", "bots"],
    limites: { lineas: 1, conectores: 1, agentes: 0 },
  },
  basico: {
    nombre: "Básico",
    capacidades: ["salientes"],
    limites: { lineas: 1, conectores: 1, agentes: 0 },
  },
  estandar: {
    nombre: "Estándar",
    capacidades: ["salientes", "entrantes", "bots"],
    limites: { lineas: 1, conectores: 1, agentes: 0 },
  },
  pro: {
    nombre: "Pro",
    capacidades: ["salientes", "entrantes", "bots", "agentes"],
    limites: { lineas: 1, conectores: 1, agentes: 1 },
  },
};

/** Ids de plan que existieron antes del modelo de capacidades. */
export const PLANES_LEGADO = ["base", "extras"] as const;

/**
 * Traduce un plan guardado a uno del modelo actual. `base` y `extras`
 * eran, en capacidades, exactamente Estándar (extras con límites
 * contratados, que ahora viven en `limitesOverride`). Un id desconocido
 * se devuelve tal cual para que quien lo lea lo registre, no lo oculte.
 */
export function normalizarPlan(plan: string): TenantPlan | string {
  if (plan === "base" || plan === "extras") return "estandar";
  return plan;
}

/** ¿Es un id de plan del modelo actual? */
export function esPlanConocido(plan: string): plan is TenantPlan {
  return plan in PLANES;
}

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
  /**
   * Límites contratados que sustituyen a los del plan. Null/ausente en
   * casi todos los tenants; solo se llena en contratos especiales.
   */
  limitesOverride?: { lineas?: number; conectores?: number; agentes?: number } | null;
  /**
   * Cambio de plan a la baja pendiente: aplica al cierre del ciclo pagado
   * (`aplicaEn`, ISO 8601), no al momento del clic. A la alza aplica
   * inmediato y este campo queda null.
   */
  planPendiente?: { plan: TenantPlan; aplicaEn: string } | null;
  /** ISO 8601 de la fecha de corte del ciclo pagado en curso; null si no aplica. */
  cicloCorteEn?: string | null;
  /** @deprecated Migrado a `limitesOverride.lineas`. Se lee solo por compatibilidad. */
  limiteLineas?: number;
  /** @deprecated Migrado a `limitesOverride.conectores`. Se lee solo por compatibilidad. */
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

/** Duración de la prueba, en días. */
export const DIAS_PRUEBA = 14;

/** Definición efectiva del plan del tenant; tolera ids legado sin migrar. */
export function planDe(t: Pick<Tenant, "plan">): DefinicionPlan {
  const id = normalizarPlan(t.plan);
  return PLANES[esPlanConocido(id) ? id : "basico"];
}

/**
 * Límites efectivos del tenant: override contratado, o los del plan.
 * Los campos deprecados `limiteLineas`/`limiteConectores` se siguen
 * leyendo hasta que la migración los mueva a `limitesOverride`.
 */
export function limitesTenant(t: Tenant): {
  lineas: number;
  conectores: number;
  agentes: number;
} {
  const base = planDe(t).limites;
  const o = t.limitesOverride ?? {};
  return {
    lineas: o.lineas ?? t.limiteLineas ?? base.lineas,
    conectores: o.conectores ?? t.limiteConectores ?? base.conectores,
    agentes: o.agentes ?? base.agentes,
  };
}

/** ¿El tenant está vigente? Falso solo si su prueba ya caducó. */
export function pruebaVigente(t: Tenant, ahora: Date = new Date()): boolean {
  if (normalizarPlan(t.plan) !== "prueba" || !t.pruebaExpiraEn) return true;
  return ahora < new Date(t.pruebaExpiraEn);
}

/**
 * ¿El tenant está en solo lectura? Prueba vencida: la bandeja y el
 * historial se ven, el envío se apaga y los bots se pausan. La
 * configuración no se borra.
 */
export function soloLectura(t: Tenant, ahora: Date = new Date()): boolean {
  return !pruebaVigente(t, ahora);
}

/**
 * Capacidades activas del tenant AHORA: las del plan, salvo que esté en
 * solo lectura (prueba vencida), en cuyo caso ninguna. Bajar de plan no
 * borra configuración: lo que el plan nuevo no incluye queda en pausa.
 */
export function capacidadesTenant(t: Tenant, ahora: Date = new Date()): Capacidad[] {
  if (soloLectura(t, ahora)) return [];
  return [...planDe(t).capacidades];
}

export function tieneCapacidad(t: Tenant, c: Capacidad, ahora: Date = new Date()): boolean {
  return capacidadesTenant(t, ahora).includes(c);
}

/** El plan que habilita una capacidad, para el mensaje de "requiere plan X". */
export function planQueHabilita(c: Capacidad): TenantPlan {
  const orden: TenantPlan[] = ["basico", "estandar", "pro"];
  return orden.find((p) => PLANES[p].capacidades.includes(c)) ?? "pro";
}

/** Mensaje literal para un 403 por capacidad ausente. */
export function mensajeRequierePlan(c: Capacidad): string {
  const nombres: Record<Capacidad, string> = {
    salientes: "Los mensajes salientes",
    entrantes: "Las automatizaciones de entrantes",
    bots: "Los flujos de bots",
    agentes: "Los agentes de IA",
  };
  return `${nombres[c]} vienen en el plan ${PLANES[planQueHabilita(c)].nombre}.`;
}

/** Orden de los planes vendidos, para saber si un cambio es a la alza o a la baja. */
export const ORDEN_PLANES: readonly TenantPlan[] = ["prueba", "basico", "estandar", "pro"];
export function esSubida(de: TenantPlan, a: TenantPlan): boolean {
  return ORDEN_PLANES.indexOf(a) > ORDEN_PLANES.indexOf(de);
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
