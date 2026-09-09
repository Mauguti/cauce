import type { FalloEnvio, Message, TenantId } from "@cauce/core";
import type { ColaEnvios } from "../cola.ts";
import type { Repositorio } from "../store.ts";
import { Cripto, pista } from "../cripto.ts";
import {
  PLANTILLA_DEFECTO_ID,
  elegirPlantilla,
  fusionarPlantillas,
  normalizarPlantillas,
  renderCuerpo,
  soloDigitos,
  type PlantillaSaliente,
  type RegistroConector,
  type ResultadoPlantilla,
} from "../conectores/plantillas.ts";
import { ClienteBitrix, valorCampo, type CampoBitrix, type EntidadBitrix } from "./cliente.ts";

/**
 * Documento del conector Bitrix24 (por tenant). Las credenciales van
 * CIFRADAS: la URL del webhook entrante lleva el token estático (como una
 * contraseña) y el application_token verifica los disparos salientes. La
 * API nunca las devuelve en claro, solo `webhookPista`.
 */
export interface ConectorBitrixDoc {
  /** Instancia (número) desde la que se envían los mensajes del tenant. */
  instanceId: string;
  /** Entidad de CRM que dispara y a cuyo timeline vuelve la respuesta. */
  entidad: EntidadBitrix;
  /** Id del campo que contiene el teléfono del cliente. */
  campoTelefono: string;
  /** Plantillas de mensaje saliente (al menos una). */
  plantillas: PlantillaSaliente[];
  /** URL del webhook entrante (base REST con token), cifrada. */
  webhookUrlCifrado: string;
  /** application_token del webhook saliente, cifrado ("" si no se usa). */
  applicationTokenCifrado: string;
  /** Pista para la UI: dominio del portal + últimos caracteres. */
  webhookPista: string;
}

/** Alta/edición en claro desde la consola (webhook vacío al editar = conserva). */
export interface AltaConectorBitrix {
  instanceId: string;
  entidad: EntidadBitrix;
  campoTelefono: string;
  webhookUrl: string;
  applicationToken: string;
  plantilla?: string;
}

export interface ResultadoDisparoBitrix {
  entidadId: string;
  telefono: string;
  mensajeId: string;
  plantillaId: string;
}

/** Pista legible: dominio del portal (si se puede leer) + cola del código. */
function pistaWebhook(url: string): string {
  const dominio = url.match(/https?:\/\/([^/]+)/)?.[1] ?? "";
  return `${dominio} · ${pista(url)}`;
}

export class ConectorBitrix {
  readonly #repo: Repositorio;
  readonly #cola: ColaEnvios;
  readonly #cripto: Cripto;
  readonly #clienteFactory: (webhookUrl: string) => ClienteBitrix;

  constructor(opciones: {
    repo: Repositorio;
    cola: ColaEnvios;
    cripto?: Cripto;
    clienteFactory?: (webhookUrl: string) => ClienteBitrix;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola;
    this.#cripto = opciones.cripto ?? new Cripto();
    this.#clienteFactory =
      opciones.clienteFactory ?? ((url) => new ClienteBitrix(url));
  }

  async guardarAlta(tenantId: TenantId, alta: AltaConectorBitrix): Promise<void> {
    const previo = await this.#repo.getConectorBitrix(tenantId);
    if (!alta.webhookUrl && !previo) {
      throw new Error("se requiere la URL del webhook entrante de Bitrix24");
    }
    const webhookUrlCifrado = alta.webhookUrl
      ? this.#cripto.cifrar(alta.webhookUrl)
      : previo!.webhookUrlCifrado;
    const webhookPista = alta.webhookUrl
      ? pistaWebhook(alta.webhookUrl)
      : previo!.webhookPista;
    const applicationTokenCifrado = alta.applicationToken
      ? this.#cripto.cifrar(alta.applicationToken)
      : (previo?.applicationTokenCifrado ?? "");
    const plantillas = previo
      ? normalizarPlantillas(previo)
      : [
          {
            id: PLANTILLA_DEFECTO_ID,
            nombre: "Plantilla principal",
            cuerpo: alta.plantilla ?? "",
          },
        ];
    await this.#repo.saveConectorBitrix(tenantId, {
      instanceId: alta.instanceId,
      entidad: alta.entidad,
      campoTelefono: alta.campoTelefono,
      plantillas,
      webhookUrlCifrado,
      applicationTokenCifrado,
      webhookPista,
    });
  }

  async verConfig(tenantId: TenantId): Promise<{
    instanceId: string;
    entidad: EntidadBitrix;
    campoTelefono: string;
    plantillas: PlantillaSaliente[];
    webhookPista: string;
    tieneApplicationToken: boolean;
  } | null> {
    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) return null;
    return {
      instanceId: doc.instanceId,
      entidad: doc.entidad,
      campoTelefono: doc.campoTelefono,
      plantillas: normalizarPlantillas(doc),
      webhookPista: doc.webhookPista,
      tieneApplicationToken: doc.applicationTokenCifrado !== "",
    };
  }

  async desconectar(tenantId: TenantId): Promise<void> {
    await this.#repo.deleteConectorBitrix(tenantId);
  }

  /** Valida un webhook pegado (antes de guardar). */
  async probar(webhookUrl: string): Promise<void> {
    await this.#clienteFactory(webhookUrl).validar();
  }

  /** Campos de una entidad con un webhook pegado (setup, antes de guardar). */
  async campos(webhookUrl: string, entidad: EntidadBitrix): Promise<CampoBitrix[]> {
    return this.#clienteFactory(webhookUrl).listarCampos(entidad);
  }

  /** Campos de la entidad ya configurada, con el webhook guardado. */
  async camposGuardados(tenantId: TenantId): Promise<CampoBitrix[]> {
    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) return [];
    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.webhookUrlCifrado));
    return cliente.listarCampos(doc.entidad);
  }

  async guardarPlantillas(
    tenantId: TenantId,
    plantillas: PlantillaSaliente[],
  ): Promise<boolean> {
    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) return false;
    await this.#repo.saveConectorBitrix(tenantId, {
      ...doc,
      plantillas: fusionarPlantillas(normalizarPlantillas(doc), plantillas),
    });
    return true;
  }

  /**
   * Verifica el disparo saliente: si se configuró application_token, debe
   * coincidir con `auth[application_token]` del payload. Si no se configuró,
   * no se exige (igual criterio que el signing secret de monday).
   */
  verificarFirma(doc: ConectorBitrixDoc, payload: any): boolean {
    if (doc.applicationTokenCifrado === "") return true;
    const esperado = this.#cripto.descifrar(doc.applicationTokenCifrado);
    const recibido = payload?.auth?.application_token ?? payload?.application_token;
    return typeof recibido === "string" && recibido === esperado;
  }

  async procesarEvento(
    tenantId: TenantId,
    payload: any,
    plantillaId?: string,
  ): Promise<ResultadoDisparoBitrix> {
    try {
      const r = await this.#procesarInterno(tenantId, payload, plantillaId);
      const ok = { ok: true as const, itemId: r.entidadId, telefono: r.telefono, en: new Date().toISOString() };
      await this.#registrarResultado(tenantId, ok);
      await this.#registrarDisparoPlantilla(tenantId, r.plantillaId, ok);
      return r;
    } catch (err: any) {
      const fail = { ok: false as const, error: err?.message ?? "error desconocido", en: new Date().toISOString() };
      await this.#registrarResultado(tenantId, fail);
      await this.#registrarDisparoPlantilla(tenantId, plantillaId, fail);
      throw err;
    }
  }

  async #procesarInterno(
    tenantId: TenantId,
    payload: any,
    plantillaId?: string,
  ): Promise<ResultadoDisparoBitrix> {
    const entidadId = extraerId(payload);
    if (!entidadId) throw new Error("evento de Bitrix sin id de entidad (data[FIELDS][ID])");

    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) throw new Error("tenant sin conector Bitrix configurado");
    const plantilla = elegirPlantilla(normalizarPlantillas(doc), plantillaId);
    if (!plantilla) throw new Error(`la plantilla ${plantillaId ?? "(por defecto)"} no existe`);

    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.webhookUrlCifrado));
    const registro = await cliente.getRegistro(doc.entidad, entidadId);
    if (!registro) throw new Error(`${doc.entidad} ${entidadId} no encontrado en Bitrix`);

    const telefonoTexto = valorCampo(registro.campos, doc.campoTelefono);
    const telefono = soloDigitos(telefonoTexto);
    if (!telefono) {
      await this.#registrarFallido(
        tenantId, doc.instanceId, "—", "", "telefono_vacio",
        `El ${doc.entidad} "${registro.nombre}" no tiene teléfono en el campo mapeado (${doc.campoTelefono}). Llénalo en Bitrix y vuelve a disparar.`,
      );
      throw new Error(`la entidad no tiene teléfono en el campo mapeado (${doc.campoTelefono})`);
    }
    const cuerpo = renderCuerpo(plantilla.cuerpo, {
      nombre: registro.nombre,
      campo: (clave) => valorCampo(registro.campos, clave),
    });
    if (!cuerpo.trim()) {
      await this.#registrarFallido(
        tenantId, doc.instanceId, `+${telefono}`, "", "item_incompleto",
        `El ${doc.entidad} "${registro.nombre}" no tiene los datos que usa la plantilla; el mensaje quedó vacío.`,
      );
      throw new Error("la plantilla quedó vacía para esta entidad");
    }

    const mensaje: Message = {
      id: crypto.randomUUID(),
      tenantId,
      instanceId: doc.instanceId,
      direccion: "out",
      telefono: `+${telefono}`,
      cuerpo,
      estado: "encolado",
      externalId: null,
      timestamp: new Date().toISOString(),
    };
    await this.#cola.encolar(mensaje);
    // Liga la conversación a la entidad de Bitrix para el retorno al timeline.
    await this.#repo.vincularBitrix(tenantId, doc.instanceId, telefono, doc.entidad, entidadId);
    return { entidadId, telefono, mensajeId: mensaje.id, plantillaId: plantilla.id };
  }

  /** Publica la respuesta del cliente en el timeline de la entidad. */
  async publicarEnItem(
    tenantId: TenantId,
    entidad: EntidadBitrix,
    entidadId: string,
    cuerpo: string,
  ): Promise<void> {
    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) return;
    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.webhookUrlCifrado));
    await cliente.comentarTimeline(entidad, entidadId, cuerpo);
  }

  async registrarLlamada(tenantId: TenantId): Promise<void> {
    const previo = await this.#repo.getRegistroBitrix(tenantId);
    await this.#repo.setRegistroBitrix(tenantId, {
      ultimaLlamadaEn: new Date().toISOString(),
      ultimoResultado: previo?.ultimoResultado ?? null,
    });
  }

  async verRegistro(tenantId: TenantId): Promise<RegistroConector> {
    return (
      (await this.#repo.getRegistroBitrix(tenantId)) ?? {
        ultimaLlamadaEn: null,
        ultimoResultado: null,
      }
    );
  }

  async #registrarResultado(tenantId: TenantId, resultado: ResultadoPlantilla): Promise<void> {
    const previo = await this.#repo.getRegistroBitrix(tenantId);
    await this.#repo.setRegistroBitrix(tenantId, {
      ultimaLlamadaEn: previo?.ultimaLlamadaEn ?? null,
      ultimoResultado: resultado,
    });
  }

  async #registrarDisparoPlantilla(
    tenantId: TenantId,
    plantillaId: string | undefined,
    resultado: ResultadoPlantilla,
  ): Promise<void> {
    const doc = await this.#repo.getConectorBitrix(tenantId);
    if (!doc) return;
    const objetivo = elegirPlantilla(normalizarPlantillas(doc), plantillaId);
    if (!objetivo) return;
    const plantillas = normalizarPlantillas(doc).map((p) =>
      p.id === objetivo.id
        ? { ...p, ultimoDisparoEn: resultado.en, ultimoResultado: resultado }
        : p,
    );
    await this.#repo.saveConectorBitrix(tenantId, { ...doc, plantillas });
  }

  async #registrarFallido(
    tenantId: TenantId,
    instanceId: string,
    telefono: string,
    cuerpo: string,
    codigo: FalloEnvio,
    error: string,
  ): Promise<void> {
    await this.#repo.saveMessage({
      id: crypto.randomUUID(),
      tenantId,
      instanceId,
      direccion: "out",
      telefono,
      cuerpo,
      estado: "fallido",
      externalId: null,
      error,
      errorCodigo: codigo,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Saca el id de la entidad del payload del webhook saliente de Bitrix. */
export function extraerId(payload: any): string | null {
  const crudo =
    payload?.data?.FIELDS?.ID ??
    payload?.data?.FIELDS?.id ??
    payload?.data?.ID ??
    payload?.FIELDS?.ID ??
    payload?.id ??
    payload?.ID;
  if (crudo === undefined || crudo === null || crudo === "") return null;
  return String(crudo);
}
