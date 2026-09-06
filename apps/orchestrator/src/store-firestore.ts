import { Firestore } from "@google-cloud/firestore";
import {
  rutas,
  type Instance,
  type InstanceId,
  type Message,
  type Tenant,
  type TenantId,
} from "@cauce/core";
import type { Repositorio } from "./store.ts";
import type { ConfigMonday } from "./monday/conector.ts";

/**
 * Repositorio sobre Firestore. Usa exactamente las `rutas` de
 * @cauce/core: cada dato vive bajo `tenants/{tenantId}/...`, así que el
 * aislamiento por tenant es la forma misma de los datos (ver ADR 0002).
 *
 * Credenciales: por GOOGLE_APPLICATION_CREDENTIALS (ruta al JSON de la
 * service account) en el entorno del servicio, nunca en el repo. El
 * project id sale de la credencial o de FIRESTORE_PROJECT_ID.
 *
 * `ignoreUndefinedProperties` deja que campos opcionales (p. ej.
 * Tenant.envioIntervaloMs) simplemente no se escriban cuando faltan.
 */
export class RepositorioFirestore implements Repositorio {
  readonly #db: Firestore;

  constructor(db?: Firestore) {
    this.#db =
      db ??
      new Firestore({
        ignoreUndefinedProperties: true,
        ...(process.env.FIRESTORE_PROJECT_ID
          ? { projectId: process.env.FIRESTORE_PROJECT_ID }
          : {}),
      });
  }

  async getTenant(tenantId: TenantId): Promise<Tenant | null> {
    const doc = await this.#db.doc(rutas.tenant(tenantId)).get();
    return doc.exists ? (doc.data() as Tenant) : null;
  }

  async listTenants(): Promise<Tenant[]> {
    const snap = await this.#db.collection("tenants").get();
    return snap.docs.map((d) => d.data() as Tenant);
  }

  async saveTenant(tenant: Tenant): Promise<void> {
    await this.#db.doc(rutas.tenant(tenant.id)).set(tenant);
  }

  async listInstances(tenantId: TenantId): Promise<Instance[]> {
    const snap = await this.#db.collection(rutas.instances(tenantId)).get();
    return snap.docs.map((d) => d.data() as Instance);
  }

  async getInstance(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<Instance | null> {
    const doc = await this.#db.doc(rutas.instance(tenantId, instanceId)).get();
    return doc.exists ? (doc.data() as Instance) : null;
  }

  async saveInstance(instance: Instance): Promise<void> {
    await this.#db
      .doc(rutas.instance(instance.tenantId, instance.id))
      .set(instance);
  }

  async deleteInstance(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<void> {
    await this.#db.doc(rutas.instance(tenantId, instanceId)).delete();
  }

  /** Upsert por id: el ciclo de la cola reescribe el mismo mensaje. */
  async saveMessage(mensaje: Message): Promise<void> {
    await this.#db
      .doc(rutas.message(mensaje.tenantId, mensaje.id))
      .set(mensaje);
  }

  async listMessages(
    tenantId: TenantId,
    instanceId?: InstanceId,
  ): Promise<Message[]> {
    const col = this.#db.collection(rutas.messages(tenantId));
    // Filtrar por instanceId usa el índice de campo único (automático).
    // El orden por timestamp lo hace quien consume (app.ts) para no
    // exigir un índice compuesto; ver docs/deploy.md.
    const snap = instanceId
      ? await col.where("instanceId", "==", instanceId).get()
      : await col.get();
    return snap.docs.map((d) => d.data() as Message);
  }

  async getConectorMonday(tenantId: TenantId): Promise<ConfigMonday | null> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday`)
      .get();
    return doc.exists ? (doc.data() as ConfigMonday) : null;
  }

  async saveConectorMonday(
    tenantId: TenantId,
    config: ConfigMonday,
  ): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday`)
      .set(config);
  }

  async getVinculoMonday(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
  ): Promise<string | null> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/mondayVinculos/${instanceId}__${telefono}`)
      .get();
    return doc.exists ? (doc.data()!.itemId as string) : null;
  }

  async saveVinculoMonday(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    itemId: string,
  ): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/mondayVinculos/${instanceId}__${telefono}`)
      .set({ instanceId, telefono, itemId });
  }
}
