import { Firestore } from "@google-cloud/firestore";
import {
  rutas,
  type Conversacion,
  type Instance,
  type InstanceId,
  type Message,
  type Tenant,
  type TenantId,
} from "@cauce/core";
import type { Repositorio } from "./store.ts";
import type { ConectorMondayDoc, RegistroMonday } from "./monday/conector.ts";
import type { DisparadorEntrada } from "./entrada/disparadores.ts";

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

  async getTenantIdDeUsuario(uid: string): Promise<TenantId | null> {
    const doc = await this.#db.doc(`usuarios/${uid}`).get();
    return doc.exists ? (doc.data()!.tenantId as TenantId) : null;
  }

  async provisionarTenant(
    uid: string,
    fabrica: () => Tenant,
  ): Promise<Tenant> {
    const refUsuario = this.#db.doc(`usuarios/${uid}`);
    // Transacción: dos altas concurrentes del mismo uid se serializan y
    // Firestore reintenta la perdedora, que ya ve usuarios/{uid} → un
    // solo tenant. Mismo patrón que registrarEntrante.
    return this.#db.runTransaction(async (tx) => {
      const snap = await tx.get(refUsuario);
      if (snap.exists) {
        const tenantId = snap.data()!.tenantId as TenantId;
        const t = await tx.get(this.#db.doc(rutas.tenant(tenantId)));
        if (t.exists) return t.data() as Tenant;
      }
      const tenant = fabrica();
      tx.set(this.#db.doc(rutas.tenant(tenant.id)), tenant);
      tx.set(refUsuario, { tenantId: tenant.id, creadoEn: tenant.creadoEn });
      return tenant;
    });
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

  async getMessage(
    tenantId: TenantId,
    messageId: string,
  ): Promise<Message | null> {
    const doc = await this.#db.doc(rutas.message(tenantId, messageId)).get();
    return doc.exists ? (doc.data() as Message) : null;
  }

  async getMessagePorExternalId(
    tenantId: TenantId,
    externalId: string,
  ): Promise<Message | null> {
    // Índice de campo único (automático) por externalId; el filtro de
    // dirección se aplica en memoria para no exigir un índice compuesto.
    const snap = await this.#db
      .collection(rutas.messages(tenantId))
      .where("externalId", "==", externalId)
      .get();
    const m = snap.docs
      .map((d) => d.data() as Message)
      .find((x) => x.direccion === "out");
    return m ?? null;
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

  async getConectorMonday(tenantId: TenantId): Promise<ConectorMondayDoc | null> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday`)
      .get();
    return doc.exists ? (doc.data() as ConectorMondayDoc) : null;
  }

  async saveConectorMonday(
    tenantId: TenantId,
    config: ConectorMondayDoc,
  ): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday`)
      .set(config);
  }

  async deleteConectorMonday(tenantId: TenantId): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/monday`).delete();
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday-registro`)
      .delete()
      .catch(() => {});
  }

  async getRegistroMonday(tenantId: TenantId): Promise<RegistroMonday | null> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday-registro`)
      .get();
    return doc.exists ? (doc.data() as RegistroMonday) : null;
  }

  async setRegistroMonday(
    tenantId: TenantId,
    registro: RegistroMonday,
  ): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/monday-registro`)
      .set(registro);
  }

  async getConversacion(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
  ): Promise<Conversacion | null> {
    const doc = await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .get();
    return doc.exists ? (doc.data() as Conversacion) : null;
  }

  async registrarEntrante(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    timestamp: string,
    nombre?: string | null,
  ): Promise<{ conversacion: Conversacion; esPrimerContacto: boolean }> {
    const ref = this.#db.doc(
      rutas.conversacion(tenantId, instanceId, telefono),
    );
    // Transacción: dos entrantes casi simultáneos del mismo número se
    // serializan y Firestore reintenta el perdedor, así exactamente uno
    // ve primerContactoEn ausente y recibe esPrimerContacto=true.
    return this.#db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const previa = snap.exists ? (snap.data() as Conversacion) : null;
      const esPrimerContacto = !previa || previa.primerContactoEn === null;
      const conversacion: Conversacion = {
        tenantId,
        instanceId,
        telefono,
        nombre: nombre?.trim() || previa?.nombre || null,
        primerContactoEn: previa?.primerContactoEn ?? timestamp,
        ultimoEntranteEn: timestamp,
        mondayItemId: previa?.mondayItemId ?? null,
      };
      tx.set(ref, conversacion);
      return { conversacion, esPrimerContacto };
    });
  }

  async listConversaciones(tenantId: TenantId): Promise<Conversacion[]> {
    // Las conversaciones viven en subcolecciones por instancia; una
    // consulta de grupo de colección las reúne, acotada por tenantId
    // (índice de campo único, automático para grupos de colección).
    const snap = await this.#db
      .collectionGroup("conversaciones")
      .where("tenantId", "==", tenantId)
      .get();
    return snap.docs.map((d) => d.data() as Conversacion);
  }

  async vincularMonday(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    itemId: string,
  ): Promise<void> {
    // merge para no pisar primerContactoEn/ultimoEntranteEn si ya existen.
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set(
        { tenantId, instanceId, telefono, mondayItemId: itemId },
        { merge: true },
      );
  }

  async getDisparadores(tenantId: TenantId): Promise<DisparadorEntrada[]> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/config/disparadores`)
      .get();
    return doc.exists ? ((doc.data()!.lista as DisparadorEntrada[]) ?? []) : [];
  }

  async saveDisparadores(
    tenantId: TenantId,
    disparadores: DisparadorEntrada[],
  ): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/config/disparadores`)
      .set({ lista: disparadores });
  }
}
