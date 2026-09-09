import type {
  Conversacion,
  Instance,
  InstanceId,
  Message,
  Tenant,
  TenantId,
} from "@cauce/core";
import type { ConectorMondayDoc, RegistroMonday } from "./monday/conector.ts";
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
    const clave = this.#claveConv(tenantId, instanceId, telefono);
    const previa = this.#conversaciones.get(clave);
    this.#conversaciones.set(clave, {
      tenantId,
      instanceId,
      telefono,
      nombre: previa?.nombre ?? null,
      primerContactoEn: previa?.primerContactoEn ?? null,
      ultimoEntranteEn: previa?.ultimoEntranteEn ?? null,
      mondayItemId: previa?.mondayItemId ?? null,
      bitrixEntidad: { tipo: entidadTipo, id: entidadId },
    });
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
    const conversacion: Conversacion = {
      tenantId,
      instanceId,
      telefono,
      nombre: nombre?.trim() || previa?.nombre || null,
      primerContactoEn: previa?.primerContactoEn ?? timestamp,
      ultimoEntranteEn: timestamp,
      mondayItemId: previa?.mondayItemId ?? null,
      bitrixEntidad: previa?.bitrixEntidad ?? null,
    };
    this.#conversaciones.set(clave, conversacion);
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
    const clave = this.#claveConv(tenantId, instanceId, telefono);
    const previa = this.#conversaciones.get(clave);
    this.#conversaciones.set(clave, {
      tenantId,
      instanceId,
      telefono,
      nombre: previa?.nombre ?? null,
      primerContactoEn: previa?.primerContactoEn ?? null,
      ultimoEntranteEn: previa?.ultimoEntranteEn ?? null,
      mondayItemId: itemId,
      bitrixEntidad: previa?.bitrixEntidad ?? null,
    });
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
