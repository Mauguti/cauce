import { FieldValue, Firestore } from "@google-cloud/firestore";
import {
  rutas,
  type Conversacion,
  type Instance,
  type InstanceId,
  type Message,
  type Tenant,
  type TenantId,
  type Conocimiento,
  type RegistroConsumo,
  type Atribucion,
  type Pago,
  type PersonaDirectorio,
  type ConectorGoogleDoc,
  type CitaPendiente,
} from "@cauce/core";
import { variantesNumero, type Repositorio } from "./store.ts";
import type { ConectorMondayDoc, RegistroMonday } from "./monday/conector.ts";
import type { ConectorBitrixDoc } from "./bitrix/conector.ts";
import type { OpenlinesBitrixDoc } from "./bitrix/openlines/tipos.ts";
import type { RegistroConector } from "./conectores/plantillas.ts";
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
 * Base de datos: por CAUCE_FIRESTORE_DB (id de una base con nombre dentro
 * del mismo proyecto). Sin la variable se usa la base por defecto
 * `(default)`, exactamente como hasta ahora. Permite que dos orquestadores
 * del mismo proyecto Firebase (p. ej. Cauce y Digsol Factory) no vean los
 * tenants del otro.
 *
 * `ignoreUndefinedProperties` deja que campos opcionales (p. ej.
 * Tenant.envioIntervaloMs) simplemente no se escriban cuando faltan.
 */
/**
 * Opciones del cliente de Firestore a partir del entorno. Pura, para
 * poder probarla sin emulador: `databaseId` solo aparece cuando
 * CAUCE_FIRESTORE_DB está definida y no vacía; `projectId` solo con
 * FIRESTORE_PROJECT_ID. Sin variables, el objeto no fuerza nada.
 */
export function opcionesFirestoreDesdeEnv(
  env: NodeJS.ProcessEnv = process.env,
): { projectId?: string; databaseId?: string } {
  const projectId = env.FIRESTORE_PROJECT_ID?.trim();
  const databaseId = env.CAUCE_FIRESTORE_DB?.trim();
  return {
    ...(projectId ? { projectId } : {}),
    ...(databaseId ? { databaseId } : {}),
  };
}

export class RepositorioFirestore implements Repositorio {
  readonly #db: Firestore;

  constructor(db?: Firestore) {
    this.#db =
      db ??
      new Firestore({
        ignoreUndefinedProperties: true,
        ...opcionesFirestoreDesdeEnv(),
      });
  }

  /** Id de la base en uso (`(default)` si no se fijó otra). Para logs. */
  get databaseId(): string {
    return this.#db.databaseId;
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
    const batch = this.#db.batch();
    batch.set(this.#db.doc(rutas.instance(instance.tenantId, instance.id)), instance);
    // Registro global número → línea, para reconocer líneas propias de
    // cualquier tenant sin índice de grupo de colección.
    if (instance.numero) {
      batch.set(this.#db.doc(`numeros/${instance.numero.replace(/[^\d]/g, "")}`), { tenantId: instance.tenantId, instanceId: instance.id, actualizadoEn: new Date().toISOString() });
    }
    await batch.commit();
  }

  async deleteInstance(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<void> {
    const previa = await this.getInstance(tenantId, instanceId);
    const batch = this.#db.batch();
    batch.delete(this.#db.doc(rutas.instance(tenantId, instanceId)));
    if (previa?.numero) batch.delete(this.#db.doc(`numeros/${previa.numero.replace(/[^\d]/g, "")}`));
    await batch.commit();
  }

  async listDirectorio(tenantId: TenantId): Promise<PersonaDirectorio[]> {
    const snap = await this.#db.collection(rutas.directorio(tenantId)).get();
    return snap.docs.map((d) => d.data() as PersonaDirectorio).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
  async getPersonaDirectorio(tenantId: TenantId, telefono: string): Promise<PersonaDirectorio | null> {
    const doc = await this.#db.doc(rutas.persona(tenantId, telefono.replace(/[^\d]/g, ""))).get();
    return doc.exists ? (doc.data() as PersonaDirectorio) : null;
  }
  async savePersonaDirectorio(tenantId: TenantId, persona: PersonaDirectorio): Promise<void> {
    await this.#db.doc(rutas.persona(tenantId, persona.telefono)).set(persona);
  }
  async deletePersonaDirectorio(tenantId: TenantId, telefono: string): Promise<void> {
    await this.#db.doc(rutas.persona(tenantId, telefono.replace(/[^\d]/g, ""))).delete();
  }
  async getConectorGoogle(tenantId: TenantId): Promise<ConectorGoogleDoc | null> {
    const doc = await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/google`).get();
    return doc.exists ? (doc.data() as ConectorGoogleDoc) : null;
  }
  async saveConectorGoogle(tenantId: TenantId, config: ConectorGoogleDoc): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/google`).set(config);
  }
  async deleteConectorGoogle(tenantId: TenantId): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/google`).delete();
  }
  async marcarCitaPendiente(tenantId: TenantId, instanceId: InstanceId, telefono: string, pendiente: CitaPendiente | null): Promise<void> {
    await this.#db.doc(rutas.conversacion(tenantId, instanceId, telefono)).set({ tenantId, instanceId, telefono, citaPendiente: pendiente }, { merge: true });
  }
  async reservarFranja(tenantId: TenantId, calendarioId: string, inicio: string, duenio: string, hastaIso: string): Promise<boolean> {
    const ref = this.#db.doc(`${rutas.reservas(tenantId)}/${encodeURIComponent(`${calendarioId}|${inicio}`)}`);
    return this.#db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const previa = doc.exists ? (doc.data() as { duenio: string; hasta: string }) : null;
      if (previa && previa.duenio !== duenio && previa.hasta > new Date().toISOString()) return false;
      tx.set(ref, { calendarioId, inicio, duenio, hasta: hastaIso });
      return true;
    });
  }
  async liberarFranja(tenantId: TenantId, calendarioId: string, inicio: string, duenio: string): Promise<void> {
    const ref = this.#db.doc(`${rutas.reservas(tenantId)}/${encodeURIComponent(`${calendarioId}|${inicio}`)}`);
    await this.#db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (doc.exists && (doc.data() as { duenio: string }).duenio === duenio) tx.delete(ref);
    });
  }

  async guardarPago(pago: Pago, tenant: Pick<Tenant, "pagadoHasta" | "cicloCorteEn">): Promise<boolean> {
    const refPago = this.#db.doc(rutas.pago(pago.tenantId, pago.id));
    const refTenant = this.#db.doc(rutas.tenant(pago.tenantId));
    return this.#db.runTransaction(async (tx) => {
      const existe = await tx.get(refPago);
      if (existe.exists) return false;
      tx.set(refPago, pago);
      tx.set(refTenant, { pagadoHasta: tenant.pagadoHasta ?? null, cicloCorteEn: tenant.cicloCorteEn ?? null }, { merge: true });
      return true;
    });
  }

  async listPagos(tenantId: TenantId): Promise<Pago[]> {
    const snap = await this.#db.collection(rutas.pagos(tenantId)).get();
    return snap.docs.map((d) => d.data() as Pago).sort((a, b) => b.en.localeCompare(a.en));
  }

  async getPago(tenantId: TenantId, pagoId: string): Promise<Pago | null> {
    const doc = await this.#db.doc(rutas.pago(tenantId, pagoId)).get();
    return doc.exists ? (doc.data() as Pago) : null;
  }

  async marcarAtribucion(tenantId: TenantId, instanceId: InstanceId, telefono: string, atribucion: Atribucion): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, atribucion }, { merge: true });
  }

  async buscarInstanciaPorNumero(telefono: string): Promise<{ tenantId: TenantId; instanceId: InstanceId } | null> {
    for (const d of variantesNumero(telefono)) {
      const doc = await this.#db.doc(`numeros/${d}`).get();
      if (doc.exists) {
        const x = doc.data()!;
        return { tenantId: String(x.tenantId), instanceId: String(x.instanceId) };
      }
    }
    return null;
  }

  async registrarRespuestaAutomatica(tenantId: TenantId, instanceId: InstanceId, telefono: string, en: string, texto: string, maxGuardadas: number): Promise<Conversacion> {
    const ref = this.#db.doc(rutas.conversacion(tenantId, instanceId, telefono));
    return this.#db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const previa = snap.exists ? (snap.data() as Conversacion) : null;
      const autoRespuestas = [...(previa?.autoRespuestas ?? []), en].slice(-maxGuardadas);
      tx.set(ref, { tenantId, instanceId, telefono, autoRespuestas, ultimaAutoRespuesta: texto }, { merge: true });
      return { ...(previa ?? { tenantId, instanceId, telefono, primerContactoEn: null, ultimoEntranteEn: null, mondayItemId: null }), autoRespuestas, ultimaAutoRespuesta: texto } as Conversacion;
    });
  }

  async pausarAutomatico(tenantId: TenantId, instanceId: InstanceId, telefono: string, datos: { hasta: string; motivo: string; conteo: number }): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, autoPausadaHasta: datos.hasta, cortacircuitos: { en: new Date().toISOString(), motivo: datos.motivo, conteo: datos.conteo } }, { merge: true });
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

  async listMessagesDeConversacion(tenantId: TenantId, instanceId: InstanceId, telefono: string, limite: number): Promise<Message[]> {
    // Dos igualdades: Firestore las sirve fusionando índices de campo único.
    // El orden lo hacemos aquí para no exigir índice compuesto.
    const digitos = telefono.replace(/[^\d]/g, "");
    const snap = await this.#db
      .collection(rutas.messages(tenantId))
      .where("instanceId", "==", instanceId)
      .where("telefono", "==", `+${digitos}`)
      .get();
    return snap.docs
      .map((d) => d.data() as Message)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-limite);
  }

  /**
   * Base de conocimiento: la plataforma la guarda en users/{uid} (campos
   * knowledge_*), y usuarios/{uid} dice a qué tenant pertenece. Se toma el
   * primer usuario del tenant; con varios usuarios, el conocimiento vive
   * en el que lo llenó (limitación conocida, se documenta).
   */
  async getConocimiento(tenantId: TenantId): Promise<Conocimiento | null> {
    const usuarios = await this.#db.collection("usuarios").where("tenantId", "==", tenantId).limit(5).get();
    for (const u of usuarios.docs) {
      const perfil = await this.#db.doc(`users/${u.id}`).get();
      if (!perfil.exists) continue;
      const d = perfil.data()!;
      const tiene = Object.keys(d).some((k) => k.startsWith("knowledge_"));
      if (!tiene) continue;
      return {
        pitch: d.knowledge_pitch ?? null,
        buyerPersona: d.knowledge_buyerPersona ?? null,
        discountPolicy: d.knowledge_discountPolicy ?? null,
        prohibitedTopics: d.knowledge_prohibitedTopics ?? null,
        toneCasual: Boolean(d.knowledge_toneCasual),
        toneConcise: Boolean(d.knowledge_toneConcise),
        toneEmpathetic: Boolean(d.knowledge_toneEmpathetic),
        idealPhrases: d.knowledge_idealPhrases ?? null,
        brandInstructions: d.knowledge_brandInstructions ?? null,
        products: Array.isArray(d.knowledge_products) ? d.knowledge_products : [],
      };
    }
    return null;
  }

  async registrarConsumo(r: RegistroConsumo): Promise<void> {
    const mes = r.en.slice(0, 7);
    const agregado = this.#db.doc(rutas.consumoMes(r.tenantId, mes));
    const llamada = this.#db.collection(rutas.consumoLlamadas(r.tenantId, mes)).doc(r.id);
    const batch = this.#db.batch();
    batch.set(llamada, r);
    batch.set(agregado, {
      tenantId: r.tenantId,
      mes,
      llamadas: FieldValue.increment(1),
      entrada: FieldValue.increment(r.entrada),
      salida: FieldValue.increment(r.salida),
      cacheLectura: FieldValue.increment(r.cacheLectura),
      cacheEscritura: FieldValue.increment(r.cacheEscritura),
      costoUsd: FieldValue.increment(r.costoUsd ?? 0),
      errores: FieldValue.increment(r.resultado === "error" ? 1 : 0),
      actualizadoEn: r.en,
    }, { merge: true });
    await batch.commit();
  }

  async listConsumo(tenantId: TenantId, mes: string): Promise<RegistroConsumo[]> {
    const snap = await this.#db.collection(rutas.consumoLlamadas(tenantId, mes)).get();
    return snap.docs.map((d) => d.data() as RegistroConsumo);
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

  async getOpenlinesBitrix(tenantId: TenantId): Promise<OpenlinesBitrixDoc | null> {
    const doc = await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix-openlines`).get();
    return doc.exists ? (doc.data() as OpenlinesBitrixDoc) : null;
  }

  async saveOpenlinesBitrix(tenantId: TenantId, doc: OpenlinesBitrixDoc): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix-openlines`).set(doc);
  }

  async deleteOpenlinesBitrix(tenantId: TenantId): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix-openlines`).delete();
  }

  async vincularOpenLine(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    datos: NonNullable<Conversacion["bitrixOpenLine"]>,
  ): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, bitrixOpenLine: datos }, { merge: true });
  }

  async marcarHumana(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    hasta: string | null,
  ): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, humanaHasta: hasta, ...(hasta ? { autoPausadaHasta: null, autoRespuestas: [] } : {}) }, { merge: true });
  }

  async marcarTraspaso(tenantId: TenantId, instanceId: InstanceId, telefono: string, traspaso: NonNullable<Conversacion["traspaso"]>): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, traspaso }, { merge: true });
  }

  async getConectorBitrix(tenantId: TenantId): Promise<ConectorBitrixDoc | null> {
    const doc = await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix`).get();
    return doc.exists ? (doc.data() as ConectorBitrixDoc) : null;
  }

  async saveConectorBitrix(tenantId: TenantId, config: ConectorBitrixDoc): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix`).set(config);
  }

  async deleteConectorBitrix(tenantId: TenantId): Promise<void> {
    await this.#db.doc(`${rutas.tenant(tenantId)}/conectores/bitrix`).delete();
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/bitrix-registro`)
      .delete()
      .catch(() => {});
  }

  async getRegistroBitrix(tenantId: TenantId): Promise<RegistroConector | null> {
    const doc = await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/bitrix-registro`)
      .get();
    return doc.exists ? (doc.data() as RegistroConector) : null;
  }

  async setRegistroBitrix(tenantId: TenantId, registro: RegistroConector): Promise<void> {
    await this.#db
      .doc(`${rutas.tenant(tenantId)}/conectores/bitrix-registro`)
      .set(registro);
  }

  async vincularBitrix(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    entidadTipo: string,
    entidadId: string,
  ): Promise<void> {
    await this.#db
      .doc(rutas.conversacion(tenantId, instanceId, telefono))
      .set({ tenantId, instanceId, telefono, bitrixEntidad: { tipo: entidadTipo, id: entidadId } }, { merge: true });
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
      // Se conserva TODO lo previo (ventana humana, vínculo con el chat de
      // Bitrix, lo que se agregue después) y solo se actualiza lo del
      // entrante. Antes se reconstruía el doc a mano y cada mensaje borraba
      // humanaHasta y bitrixOpenLine: los bots contestaban con el operador
      // en el hilo y el espejo del bot perdía el chat.
      const conversacion: Conversacion = {
        ...(previa ?? {}),
        tenantId,
        instanceId,
        telefono,
        nombre: nombre?.trim() || previa?.nombre || null,
        primerContactoEn: previa?.primerContactoEn ?? timestamp,
        ultimoEntranteEn: timestamp,
        mondayItemId: previa?.mondayItemId ?? null,
        bitrixEntidad: previa?.bitrixEntidad ?? null,
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
