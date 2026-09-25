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
  /**
   * Hasta cuándo está cubierto el pago (ISO 8601). Lo registra una persona
   * (cobro manual). Ausente/null = sin registro: se trata como al
   * corriente, porque no hay cobranza que lo contradiga. Primer pedazo de
   * docs/vencido-y-suspension.md; la suspensión NO se deriva de aquí.
   */
  pagadoHasta?: string | null;
  /** Ajustes del canal abierto de Bitrix24 (ventana humana, espaciado, ráfaga). Ausente = defaults. */
  canalAbierto?: CanalAbiertoConfig | null;
  /** Agente conversacional del tenant (Santiago). Ausente/null = sin agente. Exige la capacidad `agentes`. */
  agente?: AgenteConfig | null;
  /** Cobro: método de pago, periodo y contratación. Ausente = transferencia, como hasta ahora. */
  cobro?: CobroConfig | null;
  /** Agenda de citas (Susana): horario, duración y calendario por defecto. Ausente = defaults. */
  agenda?: AgendaConfig | null;
  /**
   * Créditos de energía comprados (MXN). No expiran. Se consumen después
   * de la bolsa mensual. Ausente/null/0 = sin créditos.
   */
  creditosMxn?: number | null;
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

/**
 * Configuración del agente de un tenant. El proveedor y el modelo se
 * eligen por tenant; el agente razona en el orquestador.
 */
export interface AgenteConfig {
  activo: boolean;
  /** Cómo se presenta: "Santiago". */
  nombre: string;
  /** Qué hace: ventas (Santiago, default) o citas (Susana: agenda sobre Google Calendar). */
  rol?: "ventas" | "citas";
  proveedor: "anthropic";
  /** Id exacto del modelo, p. ej. "claude-opus-5". */
  modelo: string;
  esfuerzo?: "low" | "medium" | "high";
  /** Instrucciones adicionales del cliente, en texto. */
  instrucciones?: string | null;
  /** Tope de tokens de salida por respuesta. */
  maxSalida?: number;
  /** Herramientas externas por webhook que el agente puede invocar (n8n u otro). */
  herramientas?: HerramientaWebhook[];
}

/**
 * Herramienta externa del agente: un POST JSON a una URL del tenant con
 * {tenantId, instanceId, telefono, contacto, herramienta, argumentos}; la
 * respuesta (texto o JSON) vuelve al modelo. El token, si lo hay, viaja
 * como Bearer y se guarda cifrado con Cripto.
 */
export interface HerramientaWebhook {
  /** Nombre que ve el modelo: snake_case, p. ej. "consultar_disponibilidad". */
  nombre: string;
  /** Cuándo usarla y qué devuelve; es lo que el modelo lee para decidir. */
  descripcion: string;
  url: string;
  /** JSON Schema de los argumentos (properties, required…). Vacío = sin argumentos. */
  parametros?: Record<string, unknown>;
  tokenCifrado?: string | null;
}

/** Producto del Catálogo del Centro de Conocimiento. */
export interface ProductoConocimiento {
  id?: string;
  name: string;
  description?: string;
  price?: number;
  currency?: "MXN" | "USD";
}

/**
 * Base de conocimiento del tenant (Centro de Conocimiento / ADN de la
 * plataforma). Campos cortos que van completos en cada consulta, más el
 * catálogo. Todos opcionales: se usa lo que el cliente haya llenado.
 */
export interface Conocimiento {
  pitch?: string | null;
  buyerPersona?: string | null;
  discountPolicy?: string | null;
  prohibitedTopics?: string | null;
  toneCasual?: boolean;
  toneConcise?: boolean;
  toneEmpathetic?: boolean;
  idealPhrases?: string | null;
  brandInstructions?: string | null;
  products?: ProductoConocimiento[];
}

/** Una llamada al modelo, con su costo. Se registra siempre, se cobra después. */
export interface RegistroConsumo {
  id: string;
  tenantId: TenantId;
  agente: string;
  instanceId: InstanceId;
  /** Enmascarado. */
  telefono: string;
  proveedor: string;
  modelo: string;
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
  /** null si el modelo no tiene precio en la tabla. */
  costoUsd: number | null;
  ms: number;
  resultado: "ok" | "rechazo" | "sin_texto" | "error";
  error: string | null;
  /** ISO 8601 */
  en: string;
  /** Herramientas invocadas en la respuesta, si hubo. */
  herramientas?: string[];
  /** Id opaco de la conversación (idConversacion): unión exacta con la conversación sin guardar el teléfono. Ausente en filas anteriores al 16-sep-2026. */
  conversacionId?: string;
}

/**
 * Id opaco y estable de una conversación (tenant + línea + teléfono). Sirve
 * para unir el ledger de consumo con la conversación sin guardar el
 * teléfono una segunda vez. Hash, no cifrado: no se puede volver al número.
 */
export function idConversacion(tenantId: TenantId, instanceId: InstanceId, telefono: string): string {
  const digitos = telefono.replace(/[^\d]/g, "");
  return hashCorto(`${tenantId}/${instanceId}/${digitos}`);
}

/** FNV-1a de 64 bits en hex (sin dependencias de Node para que el core siga siendo isomorfo). */
function hashCorto(texto: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

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
 * Atribución de campaña de una conversación. Sobre conexión no oficial no
 * hay `ctwaClid` confiable: se persiste si viene, pero NO se promete
 * devolver conversiones a Meta (eso exige API oficial).
 */
export interface Atribucion {
  estado: "atribuida" | "sin_atribuir";
  /** Resumen legible: "Meta Ads · Campaña Otoño" o la fuente UTM. */
  origen: string | null;
  utm: Record<string, string>;
  /** URL de campaña detectada en el texto, si la hubo. */
  url: string | null;
  /** Anuncio click-to-WhatsApp (contextInfo.externalAdReply), tal como llegó. */
  anuncio: { titulo: string | null; cuerpo: string | null; sourceUrl: string | null; sourceId: string | null; sourceType: string | null; ctwaClid: string | null } | null;
  capturadaEn: string;
}

export type PeriodoCobro = "mensual" | "semestral" | "anual";

/** Cómo y cuánto se le cobra al tenant. Los montos NO viven aquí: salen de la foto de precios. */
export interface CobroConfig {
  modo: "tarjeta" | "transferencia";
  periodo: PeriodoCobro;
  /** Líneas TOTALES contratadas (adicionales = total − incluidas). Ausente = 1. */
  lineasContratadas?: number;
  /** Agentes contratados en total (adicionales = contratados − incluidos en Pro). Ausente = los del plan. */
  agentesContratados?: number;
  stripeCustomerId?: string | null;
  metodo?: { id: string; marca: string; ultimos4: string; vence: string } | null;
  /** Estado del cobro del corte en curso; se limpia al registrar el pago. */
  intentos?: {
    corte: string;
    fallos: number;
    ultimoError: string | null;
    ultimoIntentoEn: string | null;
    /** El banco pidió autenticación fuera de sesión: client_secret del PaymentIntent para confirmarlo desde la plataforma. */
    requiereAccion?: string | null;
    agotado?: boolean;
  } | null;
  actualizadoEn: string;
}

/**
 * Fila del ledger de pagos (`tenants/{t}/pagos/{id}`). APPEND-ONLY: un
 * reembolso es una fila negativa, nunca un borrado. Es la única verdad
 * sobre quién está al corriente; `pagadoHasta` se deriva de aquí y solo
 * lo escribe registrarPago.
 */
export interface Pago {
  id: string;
  tenantId: TenantId;
  fuente: "stripe" | "transferencia";
  tipo: "pago" | "reembolso";
  /** pi_… / re_… de Stripe, o folio de la transferencia. Idempotente. */
  referencia: string;
  /** MXN con IVA; negativo en reembolsos. */
  montoMxn: number;
  periodo: PeriodoCobro | null;
  /** Meses que cubre (negativo en reembolsos: los que recorta). */
  meses: number;
  pagadoHastaAntes: string | null;
  pagadoHastaDespues: string;
  registradoPor: string;
  /** Con qué precios se calculó (hash de precios.json y cuándo se leyó); null en transferencias. */
  fotoPrecios: { hash: string; leidoEn: string } | null;
  /** Previsto para el PAC: nace pendiente; la emisión se dispara con el pago, sea tarjeta o transferencia. */
  cfdi: { estado: "pendiente" | "emitida" | "no_aplica"; uuid?: string | null; emitidaEn?: string | null };
  detalle?: Record<string, unknown>;
  en: string;
}

/**
 * Foto de precios que publica la plataforma (`precios.json`, generado
 * desde lib/precios.ts, la única fuente). El orquestador nunca los tiene
 * en código: sin foto leída, no cobra.
 */
export interface FotoPrecios {
  version: string;
  IVA: number;
  PRECIO_PLAN: Record<"basico" | "estandar" | "pro", number>;
  LINEAS_INCLUIDAS: number;
  LINEA_ADICIONAL: { precioHasta4: number; precioDesde5: number; umbral: number };
  AGENTE: { incluidosEnPro: number; bolsaApiMensual: number; adicional: number };
  PERIODOS: Record<PeriodoCobro, { nombre: string; meses: number; descuento: number }>;
}

export interface DesgloseCobro {
  plan: "basico" | "estandar" | "pro";
  periodo: PeriodoCobro;
  meses: number;
  descuento: number;
  lineasTotales: number;
  lineasAdicionales: number;
  precioLineaAdicional: number;
  agentesAdicionales: number;
  subtotalMensual: number;
  subtotalPeriodo: number;
  iva: number;
  /** Total con IVA, en pesos con dos decimales. */
  total: number;
  /** Total en centavos, lo que se manda a Stripe. */
  centavos: number;
}

/**
 * Lo que se cobra en un corte. Misma regla que lib/precios.ts (los VALORES
 * vienen de la foto; la regla del escalón por volumen se replica aquí y se
 * prueba contra los mismos números: 7 líneas totales en Estándar = 3,773).
 */
export function calcularCobro(f: FotoPrecios, o: { plan: "basico" | "estandar" | "pro"; lineasTotales: number; agentesAdicionales: number; periodo: PeriodoCobro }): DesgloseCobro {
  const lineasTotales = Math.max(f.LINEAS_INCLUIDAS, Math.floor(o.lineasTotales));
  const lineasAdicionales = lineasTotales - f.LINEAS_INCLUIDAS;
  const precioLineaAdicional = lineasAdicionales >= f.LINEA_ADICIONAL.umbral ? f.LINEA_ADICIONAL.precioDesde5 : f.LINEA_ADICIONAL.precioHasta4;
  const agentesAdicionales = Math.max(0, Math.floor(o.agentesAdicionales));
  const subtotalMensual = f.PRECIO_PLAN[o.plan] + lineasAdicionales * precioLineaAdicional + agentesAdicionales * f.AGENTE.adicional;
  const p = f.PERIODOS[o.periodo];
  const subtotalPeriodo = Math.round(subtotalMensual * p.meses * (1 - p.descuento) * 100) / 100;
  const iva = Math.round(subtotalPeriodo * f.IVA * 100) / 100;
  const total = Math.round((subtotalPeriodo + iva) * 100) / 100;
  return { plan: o.plan, periodo: o.periodo, meses: p.meses, descuento: p.descuento, lineasTotales, lineasAdicionales, precioLineaAdicional, agentesAdicionales, subtotalMensual, subtotalPeriodo, iva, total, centavos: Math.round(total * 100) };
}

/** Suma meses calendario a una fecha ISO. */
export function sumarMeses(iso: string, meses: number): string {
  const d = new Date(iso);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  // 31-ene + 1 mes = 28/29-feb, no 3-mar: se recorta al último día del mes destino.
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString();
}

export type EstadoPago = "prueba" | "al_corriente" | "vencido";

// ── Citas (Susana) ──────────────────────────────────────────────────────────

/**
 * Directorio del tenant: quién es quién por número. Vive a nivel tenant,
 * no dentro del ADN de un agente: todos los agentes consumen la misma
 * lista. Todo número que no está aquí es cliente. `tenants/{t}/directorio/{digitos}`.
 */
export interface PersonaDirectorio {
  /** E.164 sin '+', solo dígitos (doc id). */
  telefono: string;
  nombre: string;
  rol: "dueno" | "profesional" | "recepcion";
  /** Id del calendario de Google que atiende (profesional). null = el calendario por defecto del tenant. */
  calendarioId?: string | null;
  /** Mientras esté en el futuro, este número se trata como CLIENTE (demo desde el celular del dueño). */
  modoClienteHasta?: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

export interface AgendaConfig {
  /** Calendario por defecto (id de Google Calendar; "primary" = el principal de la cuenta conectada). */
  calendarioId: string;
  duracionMin: number;
  /** Días que se atienden (0 = domingo … 6 = sábado) y horario local del calendario. */
  horario: { dias: number[]; desde: string; hasta: string };
  /** No se ofrecen horas antes de esta anticipación. */
  anticipacionMin: number;
  /** Hasta cuántos días adelante se ofrecen horas. */
  ventanaDias: number;
}

export const AGENDA_DEFAULT: AgendaConfig = {
  calendarioId: "primary",
  duracionMin: 60,
  horario: { dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "18:00" },
  anticipacionMin: 120,
  ventanaDias: 14,
};

/** Conexión de Google (OAuth por tenant). El refresh token va cifrado con Cripto; nunca en claro. `tenants/{t}/conectores/google`. */
export interface ConectorGoogleDoc {
  email: string | null;
  refreshTokenCifrado: string;
  scope: string;
  conectadoEn: string;
}

/**
 * Cambio pendiente de confirmación en una conversación (segundo nivel):
 * la herramienta `proponer_cambio` lo deja aquí y `confirmar_cambio` solo
 * lo ejecuta en un mensaje POSTERIOR del cliente. Así la confirmación en
 * el chat es real y no una palabra que el modelo se dice a sí mismo.
 */
export interface CitaPendiente {
  accion: "agendar" | "cancelar" | "mover";
  calendarioId: string;
  /** ISO del inicio propuesto (agendar/mover). */
  inicio?: string | null;
  fin?: string | null;
  /** Evento afectado (cancelar/mover). */
  eventoId?: string | null;
  nombre?: string | null;
  resumen: string;
  propuestaEn: string;
  /** Mensaje entrante en el que se propuso; la confirmación debe venir en otro. */
  mensajeId: string;
}


/**
 * Estado de pago para mostrarlo (banner de activación, Billing). Solo
 * informa: no apaga nada. La prueba se reporta aparte porque no es un
 * cliente que paga; vencido es un cliente de paga con pagadoHasta en el
 * pasado. Sin registro de pago, al corriente.
 */
export function estadoPago(t: Tenant, ahora: Date = new Date()): EstadoPago {
  if (normalizarPlan(t.plan) === "prueba") return "prueba";
  if (t.pagadoHasta && new Date(t.pagadoHasta) <= ahora) return "vencido";
  return "al_corriente";
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
  /** Nombre que el cliente le pone a la línea ("Ventas Norte"). Opcional; sin él se muestra el número. */
  nombre?: string | null;
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
/**
 * Quién originó un saliente: el agente (Santiago), un bot (disparador), un
 * operador desde el Contact Center, un disparo del CRM, un envío manual
 * desde la plataforma o la API, o el propio sistema (avisos). Es lo que
 * permite revisar qué contestó el agente sin leer el journal.
 */
export type MessageOrigen = "agente" | "bot" | "operador" | "crm" | "manual" | "sistema";

export interface Message {
  id: MessageId;
  tenantId: TenantId;
  instanceId: InstanceId;
  direccion: MessageDireccion;
  /** Solo salientes. Ausente en mensajes anteriores a este campo. */
  origen?: MessageOrigen;
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
  /** Adjuntos del mensaje (imágenes, audio, documentos). */
  adjuntos?: Adjunto[];
  /** ISO 8601 */
  timestamp: string;
}

// ── Adjuntos ────────────────────────────────────────────────────────────

export interface Adjunto {
  id: string;
  /** Nombre original del archivo. */
  nombre: string;
  /** MIME type (p. ej. "image/jpeg", "audio/ogg; codecs=opus"). */
  tipoMime: string;
  /** Tamaño en bytes. */
  tamano: number;
  /** Ruta en disco relativa a CAUCE_ADJUNTOS_DIR. */
  ruta: string;
  /** ISO 8601 de cuándo se guardó. */
  guardadoEn: string;
  /** true cuando el archivo fue borrado por el barrido de retención. */
  expirado?: boolean;
}

/**
 * Retención de adjuntos por plan. Valor en días.
 * Básico 30 d · Estándar 180 d · Pro 365 d.
 */
export const RETENCION_DIAS: Record<TenantPlan, number> = {
  prueba: 30,
  basico: 30,
  estandar: 180,
  pro: 365,
};

/**
 * Tope de almacenamiento por cuenta (bytes). Al llegar se borra lo más
 * viejo primero; nunca se bloquea la recepción.
 */
export const TOPE_BYTES: Record<TenantPlan, number> = {
  prueba: 2 * 1024 ** 3,
  basico: 2 * 1024 ** 3,
  estandar: 10 * 1024 ** 3,
  pro: 25 * 1024 ** 3,
};

/** Tamaño máximo por archivo individual (bytes). */
export const ADJUNTO_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

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
  /**
   * El agente entregó la conversación a una persona. Se conserva hasta
   * que alguien la marque atendida; mientras, el agente calla.
   */
  traspaso?: { motivo: string; resumen: string; en: string; agente: string; atendidoEn?: string | null } | null;
  /**
   * Origen de campaña, capturado al PRIMER mensaje de la conversación y
   * nunca reconstruido después. `sin_atribuir` es explícito: no se
   * reparte ni se adivina. Capa base del plan de conexión, no de un agente.
   */
  atribucion?: Atribucion | null;
  /** Cambio de cita propuesto y aún sin confirmar (Susana). */
  citaPendiente?: CitaPendiente | null;
  /**
   * Cortacircuitos de respuestas automáticas: marcas de tiempo de las
   * últimas respuestas de bot/agente (acotado) y el último texto, para
   * detectar bucles; `autoPausadaHasta` apaga las respuestas automáticas
   * de ESTA conversación hasta esa hora o hasta que un humano conteste.
   */
  autoRespuestas?: string[];
  ultimaAutoRespuesta?: string | null;
  autoPausadaHasta?: string | null;
  cortacircuitos?: { en: string; motivo: string; conteo: number } | null;
  /**
   * Canal abierto de Bitrix24 (Contact Center). `chatId`/`sessionId` son
   * lo que Bitrix devolvió en el ÚLTIMO envío; nunca se asumen, porque
   * al cerrar la sesión y volver a escribir pueden cambiar. Null si esta
   * conversación nunca se mandó a una línea abierta.
   */
  bitrixOpenLine?: {
    lineId: number;
    chatId: string | null;
    sessionId: string | null;
    actualizadoEn: string;
  } | null;
  /**
   * Ventana humana: hasta cuándo (ISO 8601) un operador tiene el hilo y
   * los bots se pausan solo en esta conversación. Null = sin operador.
   */
  humanaHasta?: string | null;
}

/** Ajustes del canal abierto por tenant; lo ausente toma el default. */
export interface CanalAbiertoConfig {
  /** Minutos que dura la ventana humana desde el último mensaje del operador. */
  ventanaHumanaMin?: number;
  /** Espaciado mínimo entre mensajes a la MISMA conversación (carril inmediato). */
  espaciadoMs?: number;
  /** Tope de ráfaga por línea: más de `rafagaN` mensajes en `rafagaSeg` segundos van a la cola normal. */
  rafagaN?: number;
  rafagaSeg?: number;
}

/** Defaults del canal abierto (aprobados 12-sep-2026); se mueven con evidencia del dogfooding, no con adivinanza. */
export const CANAL_ABIERTO_DEFAULTS: Required<CanalAbiertoConfig> = {
  ventanaHumanaMin: 30,
  espaciadoMs: 2_000,
  rafagaN: 10,
  rafagaSeg: 60,
};

export function canalAbiertoDe(t: Pick<Tenant, "canalAbierto">): Required<CanalAbiertoConfig> {
  const c = t.canalAbierto ?? {};
  return {
    ventanaHumanaMin: c.ventanaHumanaMin ?? CANAL_ABIERTO_DEFAULTS.ventanaHumanaMin,
    espaciadoMs: c.espaciadoMs ?? CANAL_ABIERTO_DEFAULTS.espaciadoMs,
    rafagaN: c.rafagaN ?? CANAL_ABIERTO_DEFAULTS.rafagaN,
    rafagaSeg: c.rafagaSeg ?? CANAL_ABIERTO_DEFAULTS.rafagaSeg,
  };
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
  /** Consumo de agentes por mes (YYYY-MM): agregado en el doc, llamadas en la subcolección. */
  consumoMes: (tenantId: TenantId, mes: string) => `tenants/${tenantId}/consumo/${mes}`,
  consumoLlamadas: (tenantId: TenantId, mes: string) => `tenants/${tenantId}/consumo/${mes}/llamadas`,
  directorio: (tenantId: TenantId) => `tenants/${tenantId}/directorio`,
  persona: (tenantId: TenantId, telefono: string) => `tenants/${tenantId}/directorio/${telefono}`,
  /** Candados de franja (anti-empalme entre conversaciones nuestras): doc id `calendarioId|inicioISO`. */
  reservas: (tenantId: TenantId) => `tenants/${tenantId}/reservas`,
  /** Ledger de pagos, append-only. */
  pagos: (tenantId: TenantId) => `tenants/${tenantId}/pagos`,
  pago: (tenantId: TenantId, pagoId: string) => `tenants/${tenantId}/pagos/${pagoId}`,
} as const;
