import type { Instance, InstanceId, Tenant, TenantId } from "@cauce/core";

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
  listInstances(tenantId: TenantId): Promise<Instance[]>;
  getInstance(tenantId: TenantId, instanceId: InstanceId): Promise<Instance | null>;
  saveInstance(instance: Instance): Promise<void>;
}

export class RepositorioEnMemoria implements Repositorio {
  #tenants = new Map<TenantId, Tenant>();
  #instances = new Map<TenantId, Map<InstanceId, Instance>>();

  constructor(semilla?: { tenants: Tenant[]; instances: Instance[] }) {
    for (const t of semilla?.tenants ?? []) this.#tenants.set(t.id, t);
    for (const i of semilla?.instances ?? []) void this.saveInstance(i);
  }

  async getTenant(tenantId: TenantId): Promise<Tenant | null> {
    return this.#tenants.get(tenantId) ?? null;
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
}
