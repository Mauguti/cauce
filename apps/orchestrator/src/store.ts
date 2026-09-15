import type {
  Atribucion,
  Conocimiento,
  Conversacion,
  Instance,
  InstanceId,
  Message,
  RegistroConsumo,
  Tenant,
  TenantId,
} from "@cauce/core";
import type { ConectorMondayDoc, RegistroMonday } from "./monday/conector.ts";
import type { OpenlinesBitrixDoc } from "./bitrix/openlines/tipos.ts";
import type { ConectorBitrixDoc } from "./bitrix/conector.ts";
import type { RegistroConector } from "./conectores/plantillas.ts";
import type { DisparadorEntrada } from "./entrada/disparadores.ts";

/**
 * Repositorio scopeado por tenant. Toda operación exige `tenantId`;
 * no existe forma de listar datos cruzando tenants.
 *
 * TODO: implementación Firestore (subcolecciones `tenants/{id}/...`,
 * rutas en `rutas` de @cauce/core) cuando se conecte GCP. La interfaz
 * no cambia.
 */
export interface Repositorio {
  getTenant(tenantId: TenantId): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  saveTenant(tenant: Tenant): Promise<void>;
  /** tenantId asociado a un usuario de Firebase, o null. */
  getTenantIdDeUsuario(uid: string): Promise<TenantId | null>;
  /**
   * Get-or-create ATÓMICO del tenant de un usuario: si ya hay un tenant
   * para `uid` lo devuelve; si no, crea `fabrica()` y lo asocia. Dos
   * requests concurrentes del mismo uid resultan en UN solo tenant.
   */
  provisionarTenant(uid: string, fabrica: () => Tenant): Promise<Tenant>;
  listInstances(tenantId: TenantId): Promise<Instance[]>;
  getInstance(tenantId: TenantId, instanceId: InstanceId): Promise<Instance | null>;
  saveInstance(instance: Instance): Promise<void>;
  deleteInstance(tenantId: TenantId, instanceId: InstanceId): Promise<void>;
  saveMessage(mensaje: Message): Promise<void>;
  getMessage(tenantId: TenantId, messageId: string): Promise<Message | null>;
  /** Busca un saliente por el id que le asignó el transporte (key.id). */
  getMessagePorExternalId(
    tenantId: TenantId,
    externalId: string,
  ): Promise<Message | null>;
  listMessages(tenantId: TenantId, instanceId?: InstanceId): Promise<Message[]>;
  /** Últimos `limite` mensajes de una conversación (instancia + teléfono en dígitos), en orden cronológico. */
  listMessagesDeConversacion(tenantId: TenantId, instanceId: InstanceId, telefono: string, limite: number): Promise<Message[]>;

  // Agentes: base de conocimiento (la escribe la plataforma) y consumo (lo escribe el orquestador).
  getConocimiento(tenantId: TenantId): Promise<Conocimiento | null>;
  registrarConsumo(registro: RegistroConsumo): Promise<void>;
  /** Llamadas del mes (YYYY-MM), para el medidor. */
  listConsumo(tenantId: TenantId, mes: string): Promise<RegistroConsumo[]>;
  /** El agente traspasó la conversación a una persona. */
  marcarTraspaso(tenantId: TenantId, instanceId: InstanceId, telefono: string, traspaso: NonNullable<Conversacion["traspaso"]>): Promise<void>;
  /** Atribución de campaña de la conversación; solo se escribe una vez (primer contacto). */
  marcarAtribucion(tenantId: TenantId, instanceId: InstanceId, telefono: string, atribucion: Atribucion): Promise<void>;
  /** ¿Este número es una línea conectada de ALGÚN tenant? (anti-bucle entre agentes). */
  buscarInstanciaPorNumero(telefono: string): Promise<{ tenantId: TenantId; instanceId: InstanceId } | null>;
  /** Anota una respuesta automática en la conversación (ventana acotada) y devuelve el estado para el cortacircuitos. */
  registrarRespuestaAutomatica(tenantId: TenantId, instanceId: InstanceId, telefono: string, en: string, texto: string, maxGuardadas: number): Promise<Conversacion>;
  /** Apaga las respuestas automáticas de la conversación hasta `hasta`. */
  pausarAutomatico(tenantId: TenantId, instanceId: InstanceId, telefono: string, datos: { hasta: string; motivo: string; conteo: number }): Promise<void>;
  // Conector monday: configuración por tenant.
  getConectorMonday(tenantId: TenantId): Promise<ConectorMondayDoc | null>;
  saveConectorMonday(tenantId: TenantId, config: ConectorMondayDoc): Promise<void>;
  deleteConectorMonday(tenantId: TenantId): Promise<void>;
  getRegistroMonday(tenantId: TenantId): Promise<RegistroMonday | null>;
  setRegistroMonday(tenantId: TenantId, registro: RegistroMonday): Promise<void>;
  // Conector Bitrix24 (mismo patrón que monday).
  getConectorBitrix(tenantId: TenantId): Promise<ConectorBitrixDoc | null>;
  saveConectorBitrix(tenantId: TenantId, config: ConectorBitrixDoc): Promise<void>;
  deleteConectorBitrix(tenantId: TenantId): Promise<void>;
  getRegistroBitrix(tenantId: TenantId): Promise<RegistroConector | null>;
  setRegistroBitrix(tenantId: TenantId, registro: RegistroConector): Promise<void>;
  /** Liga (merge) la entidad de Bitrix a la conversación. */
  vincularBitrix(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    entidadTipo: string,
    entidadId: string,
  ): Promise<void>;

  // Conversaciones (identidad estable por instancia+teléfono).
  getConversacion(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
  ): Promise<Conversacion | null>;
  /**
   * Registra un mensaje entrante de forma ATÓMICA y devuelve si fue el
   * primer contacto. La atomicidad es la que resuelve la carrera de dos
   * entrantes casi simultáneos del mismo número: exactamente uno recibe
   * esPrimerContacto=true.
   */
  registrarEntrante(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    timestamp: string,
    nombre?: string | null,
  ): Promise<{ conversacion: Conversacion; esPrimerContacto: boolean }>;
  /** Todas las conversaciones del tenant (para dar contexto al registro). */
  listConversaciones(tenantId: TenantId): Promise<Conversacion[]>;
  /** Fija (merge) el item de monday vinculado a la conversación. */
  vincularMonday(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    itemId: string,
  ): Promise<void>;

  // Canal abierto de Bitrix24 (Contact Center): un documento por tenant.
  getOpenlinesBitrix(tenantId: TenantId): Promise<OpenlinesBitrixDoc | null>;
  saveOpenlinesBitrix(tenantId: TenantId, doc: OpenlinesBitrixDoc): Promise<void>;
  deleteOpenlinesBitrix(tenantId: TenantId): Promise<void>;
  /** Fija (merge) lo que Bitrix devolvió para esta conversación en la línea abierta. */
  vincularOpenLine(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    datos: NonNullable<Conversacion["bitrixOpenLine"]>,
  ): Promise<void>;
  /** Fija (merge) hasta cuándo un operador tiene el hilo; null la libera. */
  marcarHumana(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    hasta: string | null,
  ): Promise<void>;

  // Disparadores de entrada por tenant (lista ordenada por prioridad).
  getDisparadores(tenantId: TenantId): Promise<DisparadorEntrada[]>;
  saveDisparadores(
    tenantId: TenantId,
    disparadores: DisparadorEntrada[],
  ): Promise<void>;
}

export class RepositorioEnMemoria implements Repositorio {
  #tenants = new Map<TenantId, Tenant>();
  #instances = new Map<TenantId, Map<InstanceId, Instance>>();
  #messages = new Map<TenantId, Message[]>();
  #usuarios = new Map<string, TenantId>();

  constructor(semilla?: { tenants: Tenant[]; instances?: Instance[] }) {
    for (const t of semilla?.tenants ?? []) this.#tenants.set(t.id, t);
    for (const i of semilla?.instances ?? []) void this.saveInstance(i);
  }

  async getTenantIdDeUsuario(uid: string): Promise<TenantId | null> {
    return this.#usuarios.get(uid) ?? null;
  }

  async provisionarTenant(
    uid: string,
    fabrica: () => Tenant,
  ): Promise<Tenant> {
    // Sin `await` entre la lectura y las escrituras: atómico frente a
    // otras llamadas concurrentes en el modelo de un solo hilo de JS.
    const existente = this.#usuarios.get(uid);
    if (existente) {
      const t = this.#tenants.get(existente);
      if (t) return t;
    }
    const tenant = fabrica();
    this.#tenants.set(tenant.id, tenant);
    this.#usuarios.set(uid, tenant.id);
    return tenant;
  }

  async getTenant(tenantId: TenantId): Promise<Tenant | null> {
    return this.#tenants.get(tenantId) ?? null;
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.#tenants.values()];
  }

  async saveTenant(tenant: Tenant): Promise<void> {
    this.#tenants.set(tenant.id, tenant);
  }

  async listInstances(tenantId: TenantId): Promise<Instance[]> {
    return [...(this.#instances.get(tenantId)?.values() ?? [])];
  }

  async getInstance(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<Instance | null> {
    return this.#instances.get(tenantId)?.get(instanceId) ?? null;
  }

  async saveInstance(instance: Instance): Promise<void> {
    let porTenant = this.#instances.get(instance.tenantId);
    if (!porTenant) {
      porTenant = new Map();
      this.#instances.set(instance.tenantId, porTenant);
    }
    porTenant.set(instance.id, instance);
  }

  async deleteInstance(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<void> {
    this.#instances.get(tenantId)?.delete(instanceId);
  }

  /** Upsert por id: el ciclo de la cola reescribe el mismo mensaje. */
  async saveMessage(mensaje: Message): Promise<void> {
    let porTenant = this.#messages.get(mensaje.tenantId);
    if (!porTenant) {
      porTenant = [];
      this.#messages.set(mensaje.tenantId, porTenant);
    }
    const indice = porTenant.findIndex((m) => m.id === mensaje.id);
    if (indice >= 0) porTenant[indice] = mensaje;
    else porTenant.push(mensaje);
  }

  async getMessage(
    tenantId: TenantId,
    messageId: string,
  ): Promise<Message | null> {
    return (
      (this.#messages.get(tenantId) ?? []).find((m) => m.id === messageId) ??
      null
    );
  }

  async getMessagePorExternalId(
    tenantId: TenantId,
    externalId: string,
  ): Promise<Message | null> {
    return (
      (this.#messages.get(tenantId) ?? []).find(
        (m) => m.direccion === "out" && m.externalId === externalId,
      ) ?? null
    );
  }

  async listMessages(
    tenantId: TenantId,
    instanceId?: InstanceId,
  ): Promise<Message[]> {
    const todos = this.#messages.get(tenantId) ?? [];
    return instanceId
      ? todos.filter((m) => m.instanceId === instanceId)
      : [...todos];
  }

  async listMessagesDeConversacion(tenantId: TenantId, instanceId: InstanceId, telefono: string, limite: number): Promise<Message[]> {
    const digitos = telefono.replace(/[^\d]/g, "");
    return (this.#messages.get(tenantId) ?? [])
      .filter((m) => m.instanceId === instanceId && m.telefono.replace(/[^\d]/g, "") === digitos)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-limite);
  }

  #conocimiento = new Map<TenantId, Conocimiento>();
  #consumos: RegistroConsumo[] = [];

  async getConocimiento(tenantId: TenantId): Promise<Conocimiento | null> {
    return this.#conocimiento.get(tenantId) ?? null;
  }

  /** Solo memoria (pruebas y desarrollo): en Firestore la escribe la plataforma. */
  async saveConocimiento(tenantId: TenantId, c: Conocimiento): Promise<void> {
    this.#conocimiento.set(tenantId, c);
  }

  async registrarConsumo(registro: RegistroConsumo): Promise<void> {
    this.#consumos.push(registro);
  }

  /** Solo memoria (pruebas). */
  listConsumos(tenantId: TenantId): RegistroConsumo[] {
    return this.#consumos.filter((c) => c.tenantId === tenantId);
  }

  async listConsumo(tenantId: TenantId, mes: string): Promise<RegistroConsumo[]> {
    return this.#consumos.filter((c) => c.tenantId === tenantId && c.en.startsWith(mes));
  }

  #conectorMonday = new Map<TenantId, ConectorMondayDoc>();
  #conversaciones = new Map<string, Conversacion>();
  #disparadores = new Map<TenantId, DisparadorEntrada[]>();

  async getConectorMonday(tenantId: TenantId): Promise<ConectorMondayDoc | null> {
    return this.#conectorMonday.get(tenantId) ?? null;
  }

  async saveConectorMonday(
    tenantId: TenantId,
    config: ConectorMondayDoc,
  ): Promise<void> {
    this.#conectorMonday.set(tenantId, config);
  }

  async deleteConectorMonday(tenantId: TenantId): Promise<void> {
    this.#conectorMonday.delete(tenantId);
    this.#registroMonday.delete(tenantId);
  }

  #registroMonday = new Map<TenantId, RegistroMonday>();

  async getRegistroMonday(tenantId: TenantId): Promise<RegistroMonday | null> {
    return this.#registroMonday.get(tenantId) ?? null;
  }

  async setRegistroMonday(
    tenantId: TenantId,
    registro: RegistroMonday,
  ): Promise<void> {
    this.#registroMonday.set(tenantId, registro);
  }

  #conectorBitrix = new Map<TenantId, ConectorBitrixDoc>();
  #registroBitrix = new Map<TenantId, RegistroConector>();

  async getConectorBitrix(tenantId: TenantId): Promise<ConectorBitrixDoc | null> {
    return this.#conectorBitrix.get(tenantId) ?? null;
  }

  async saveConectorBitrix(tenantId: TenantId, config: ConectorBitrixDoc): Promise<void> {
    this.#conectorBitrix.set(tenantId, config);
  }

  async deleteConectorBitrix(tenantId: TenantId): Promise<void> {
    this.#conectorBitrix.delete(tenantId);
    this.#registroBitrix.delete(tenantId);
  }

  async getRegistroBitrix(tenantId: TenantId): Promise<RegistroConector | null> {
    return this.#registroBitrix.get(tenantId) ?? null;
  }

  async setRegistroBitrix(tenantId: TenantId, registro: RegistroConector): Promise<void> {
    this.#registroBitrix.set(tenantId, registro);
  }

  async vincularBitrix(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    entidadTipo: string,
    entidadId: string,
  ): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { bitrixEntidad: { tipo: entidadTipo, id: entidadId } });
  }

  #openlines = new Map<TenantId, OpenlinesBitrixDoc>();

  async getOpenlinesBitrix(tenantId: TenantId): Promise<OpenlinesBitrixDoc | null> {
    return this.#openlines.get(tenantId) ?? null;
  }

  async saveOpenlinesBitrix(tenantId: TenantId, doc: OpenlinesBitrixDoc): Promise<void> {
    this.#openlines.set(tenantId, doc);
  }

  async deleteOpenlinesBitrix(tenantId: TenantId): Promise<void> {
    this.#openlines.delete(tenantId);
  }

  #fusionarConversacion(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    cambios: Partial<Conversacion>,
  ): void {
    const clave = this.#claveConv(tenantId, instanceId, telefono);
    const previa = this.#conversaciones.get(clave);
    // Se conserva TODO lo previo (misma regla que registrarEntrante): un
    // campo nuevo en Conversacion no debe perderse por no estar listado aquí.
    this.#conversaciones.set(clave, {
      nombre: null,
      primerContactoEn: null,
      ultimoEntranteEn: null,
      mondayItemId: null,
      bitrixEntidad: null,
      bitrixOpenLine: null,
      humanaHasta: null,
      ...(previa ?? {}),
      tenantId,
      instanceId,
      telefono,
      ...cambios,
    });
  }

  async vincularOpenLine(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    datos: NonNullable<Conversacion["bitrixOpenLine"]>,
  ): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { bitrixOpenLine: datos });
  }

  async marcarHumana(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    hasta: string | null,
  ): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { humanaHasta: hasta, ...(hasta ? { autoPausadaHasta: null, autoRespuestas: [] } : {}) });
  }

  async marcarTraspaso(tenantId: TenantId, instanceId: InstanceId, telefono: string, traspaso: NonNullable<Conversacion["traspaso"]>): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { traspaso });
  }

  async marcarAtribucion(tenantId: TenantId, instanceId: InstanceId, telefono: string, atribucion: Atribucion): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { atribucion });
  }

  async buscarInstanciaPorNumero(telefono: string): Promise<{ tenantId: TenantId; instanceId: InstanceId } | null> {
    const buscados = new Set(variantesNumero(telefono));
    for (const [tenantId, porTenant] of this.#instances) {
      for (const i of porTenant.values()) {
        if (i.numero && buscados.has(i.numero.replace(/[^\d]/g, ""))) return { tenantId, instanceId: i.id };
      }
    }
    return null;
  }

  async registrarRespuestaAutomatica(tenantId: TenantId, instanceId: InstanceId, telefono: string, en: string, texto: string, maxGuardadas: number): Promise<Conversacion> {
    const previa = this.#conversaciones.get(this.#claveConv(tenantId, instanceId, telefono));
    const autoRespuestas = [...(previa?.autoRespuestas ?? []), en].slice(-maxGuardadas);
    this.#fusionarConversacion(tenantId, instanceId, telefono, { autoRespuestas, ultimaAutoRespuesta: texto });
    return this.#conversaciones.get(this.#claveConv(tenantId, instanceId, telefono))!;
  }

  async pausarAutomatico(tenantId: TenantId, instanceId: InstanceId, telefono: string, datos: { hasta: string; motivo: string; conteo: number }): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { autoPausadaHasta: datos.hasta, cortacircuitos: { en: new Date().toISOString(), motivo: datos.motivo, conteo: datos.conteo } });
  }

  #claveConv(t: TenantId, i: InstanceId, tel: string): string {
    return `${t}/${i}/${tel}`;
  }

  async getConversacion(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
  ): Promise<Conversacion | null> {
    return (
      this.#conversaciones.get(this.#claveConv(tenantId, instanceId, telefono)) ??
      null
    );
  }

  async registrarEntrante(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    timestamp: string,
    nombre?: string | null,
  ): Promise<{ conversacion: Conversacion; esPrimerContacto: boolean }> {
    // Sin `await` entre lectura y escritura: en el modelo de un solo hilo
    // de JS esto es atómico frente a otras llamadas concurrentes.
    const clave = this.#claveConv(tenantId, instanceId, telefono);
    const previa = this.#conversaciones.get(clave);
    const esPrimerContacto = !previa || previa.primerContactoEn === null;
    // ÚNICO camino de escritura: fusionar. Dos bugs de la misma familia
    // salieron de reconstruir el documento a mano (se perdían humanaHasta,
    // bitrixOpenLine, traspaso); ya no hay segundo camino.
    this.#fusionarConversacion(tenantId, instanceId, telefono, {
      nombre: nombre?.trim() || previa?.nombre || null,
      primerContactoEn: previa?.primerContactoEn ?? timestamp,
      ultimoEntranteEn: timestamp,
    });
    const conversacion = this.#conversaciones.get(clave)!;
    return { conversacion, esPrimerContacto };
  }

  async listConversaciones(tenantId: TenantId): Promise<Conversacion[]> {
    return [...this.#conversaciones.values()].filter(
      (c) => c.tenantId === tenantId,
    );
  }

  async vincularMonday(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    itemId: string,
  ): Promise<void> {
    this.#fusionarConversacion(tenantId, instanceId, telefono, { mondayItemId: itemId });
  }

  async getDisparadores(tenantId: TenantId): Promise<DisparadorEntrada[]> {
    return [...(this.#disparadores.get(tenantId) ?? [])];
  }

  async saveDisparadores(
    tenantId: TenantId,
    disparadores: DisparadorEntrada[],
  ): Promise<void> {
    this.#disparadores.set(tenantId, [...disparadores]);
  }
}

/** Dígitos de un número y sus variantes mexicanas (+521/+52), para comparar líneas. */
export function variantesNumero(telefono: string): string[] {
  const d = telefono.replace(/[^\d]/g, "");
  const v = new Set([d]);
  if (d.startsWith("521") && d.length === 13) v.add(`52${d.slice(3)}`);
  else if (d.startsWith("52") && d.length === 12) v.add(`521${d.slice(2)}`);
  return [...v];
}
