import type {
  Instance,
  InstanceId,
  Message,
  Tenant,
  TenantId,
} from "@cauce/core";

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
  listInstances(tenantId: TenantId): Promise<Instance[]>;
  getInstance(tenantId: TenantId, instanceId: InstanceId): Promise<Instance | null>;
  saveInstance(instance: Instance): Promise<void>;
  deleteInstance(tenantId: TenantId, instanceId: InstanceId): Promise<void>;
  saveMessage(mensaje: Message): Promise<void>;
  listMessages(tenantId: TenantId, instanceId?: InstanceId): Promise<Message[]>;
}

export class RepositorioEnMemoria implements Repositorio {
  #tenants = new Map<TenantId, Tenant>();
  #instances = new Map<TenantId, Map<InstanceId, Instance>>();
  #messages = new Map<TenantId, Message[]>();

  constructor(semilla?: { tenants: Tenant[]; instances?: Instance[] }) {
    for (const t of semilla?.tenants ?? []) this.#tenants.set(t.id, t);
    for (const i of semilla?.instances ?? []) void this.saveInstance(i);
  }

  async getTenant(tenantId: TenantId): Promise<Tenant | null> {
    return this.#tenants.get(tenantId) ?? null;
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.#tenants.values()];
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

  async listMessages(
    tenantId: TenantId,
    instanceId?: InstanceId,
  ): Promise<Message[]> {
    const todos = this.#messages.get(tenantId) ?? [];
    return instanceId
      ? todos.filter((m) => m.instanceId === instanceId)
      : [...todos];
  }
}
