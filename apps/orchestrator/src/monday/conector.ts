import jwt from "jsonwebtoken";
import type { FalloEnvio, Message, TenantId } from "@cauce/core";
import type { ColaEnvios } from "../cola.ts";
import type { Repositorio } from "../store.ts";
import { Cripto, pista } from "../cripto.ts";
import { registrar } from "../log.ts";
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
import { ClienteMonday, type BoardMonday, type ColumnaBoard, type ItemMonday, type PaginaBoards } from "./cliente.ts";

/**
 * Ventana de deduplicación: el mismo item no vuelve a disparar la misma
 * plantilla dentro de este tiempo. Un solo lugar para cambiarla.
 */
export const DEDUP_VENTANA_MS = 10 * 60_000;

/** Rechazo de un evento de webhook: queda en bitácora con IP y motivo, no se dispara nada. */
export class EventoRechazado extends Error {
  readonly motivo: "item_fuera_del_tablero" | "duplicado" | "sin_item";
  constructor(motivo: EventoRechazado["motivo"], detalle: string) {
    super(detalle);
    this.name = "EventoRechazado";
    this.motivo = motivo;
  }
}
import { variantesTelefono } from "../bitrix/cliente.ts";
import type { ProspectoCrm } from "../bitrix/conector.ts";

// Reexporta las piezas compartidas para no romper a los consumidores del
// conector monday (store, tests) que las importaban desde aquí.
export {
  PLANTILLA_DEFECTO_ID,
  normalizarPlantillas,
  type PlantillaSaliente,
  type ResultadoPlantilla,
};

/**
 * Documento guardado del conector monday (por tenant). Las credenciales
 * van CIFRADAS en reposo (ver cripto.ts); la API nunca las devuelve en
 * claro, solo `apiTokenPista` (últimos caracteres) para reconocerlas.
 */
export interface ConectorMondayDoc {
  /** Instancia (número) desde la que se envían los mensajes del tenant. */
  instanceId: string;
  /** Board de monday elegido; contexto de las columnas de la plantilla. */
  boardId: string;
  /** Nombre del board, para mostrarlo al reabrir sin re-consultar. */
  boardNombre: string;
  /** columnId de monday que contiene el teléfono del cliente. */
  columnaTelefono: string;
  /** Plantillas de mensaje saliente (al menos una). */
  plantillas: PlantillaSaliente[];
  /** API token de monday, cifrado. */
  apiTokenCifrado: string;
  /** Signing Secret de la app de monday, cifrado ("" si no se configuró). */
  signingSecretCifrado: string;
  /** Últimos caracteres del API token, en claro, para la UI. */
  apiTokenPista: string;
}

/**
 * Datos en claro que la consola envía para dar de alta o editar el
 * conector. Al EDITAR, apiToken/signingSecret pueden venir vacíos: se
 * conservan los ya guardados (el token está enmascarado en la UI y no se
 * repite). En un alta nueva, apiToken es obligatorio. `plantilla` es
 * opcional: siembra la plantilla por defecto solo en el alta nueva; la
 * gestión de plantillas vive aparte (guardarPlantillas).
 */
export interface AltaConectorMonday {
  instanceId: string;
  boardId: string;
  boardNombre?: string;
  columnaTelefono: string;
  plantilla?: string;
  apiToken: string;
  signingSecret: string;
}

/** Reemplaza {{nombre}} y {{columnId}} por los valores del item. */
export function renderPlantilla(plantilla: string, item: ItemMonday): string {
  return renderCuerpo(plantilla, {
    nombre: item.name,
    campo: (clave) => item.columnas[clave]?.text ?? "",
  });
}

export interface ResultadoDisparo {
  itemId: string;
  telefono: string;
  mensajeId: string;
  /** Plantilla que se usó (la de la URL, o la por defecto). */
  plantillaId: string;
}

/**
 * Rastro observable del conector para la UI: cuándo llamó monday por
 * última vez y cómo terminó el último disparo. Es el tipo compartido por
 * todos los conectores (ver RegistroConector).
 */
export type RegistroMonday = RegistroConector;

export class ConectorMonday {
  readonly #repo: Repositorio;
  readonly #cola: ColaEnvios;
  readonly #cripto: Cripto;
  readonly #clienteFactory: (token: string) => ClienteMonday;
  readonly #ahora: () => number;
  /** Disparos recientes: `${tenant}/${plantilla}/${item}` → epoch ms. */
  #recientes = new Map<string, number>();

  constructor(opciones: {
    repo: Repositorio;
    cola: ColaEnvios;
    cripto?: Cripto;
    /** Inyectable para pruebas. */
    clienteFactory?: (token: string) => ClienteMonday;
    ahora?: () => number;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola;
    this.#cripto = opciones.cripto ?? new Cripto();
    this.#clienteFactory =
      opciones.clienteFactory ?? ((token) => new ClienteMonday(token));
    this.#ahora = opciones.ahora ?? (() => Date.now());
  }

  /**
   * Cifra las credenciales del alta y las guarda. Al editar (apiToken /
   * signingSecret vacíos) conserva las credenciales ya guardadas en vez
   * de sobrescribirlas con vacío. Lanza si es alta nueva sin token.
   */
  async guardarAlta(tenantId: TenantId, alta: AltaConectorMonday): Promise<void> {
    const previo = await this.#repo.getConectorMonday(tenantId);
    if (!alta.apiToken && !previo) {
      throw new Error("se requiere el API token de monday para conectar");
    }
    const apiTokenCifrado = alta.apiToken
      ? this.#cripto.cifrar(alta.apiToken)
      : previo!.apiTokenCifrado;
    const apiTokenPista = alta.apiToken ? pista(alta.apiToken) : previo!.apiTokenPista;
    const signingSecretCifrado = alta.signingSecret
      ? this.#cripto.cifrar(alta.signingSecret)
      : (previo?.signingSecretCifrado ?? "");
    // Las plantillas se conservan al editar; en alta nueva se siembra la
    // por defecto con `alta.plantilla` (o vacía).
    const plantillas = previo
      ? normalizarPlantillas(previo)
      : [
          {
            id: PLANTILLA_DEFECTO_ID,
            nombre: "Plantilla principal",
            cuerpo: alta.plantilla ?? "",
          },
        ];
    await this.#repo.saveConectorMonday(tenantId, {
      instanceId: alta.instanceId,
      boardId: alta.boardId,
      boardNombre: alta.boardNombre ?? previo?.boardNombre ?? "",
      columnaTelefono: alta.columnaTelefono,
      plantillas,
      apiTokenCifrado,
      signingSecretCifrado,
      apiTokenPista,
    });
  }

  /** Vista de la config para la UI: sin secretos, solo la pista del token. */
  async verConfig(tenantId: TenantId): Promise<{
    instanceId: string;
    boardId: string;
    boardNombre: string;
    columnaTelefono: string;
    plantillas: PlantillaSaliente[];
    apiTokenPista: string;
    tieneSigningSecret: boolean;
  } | null> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return null;
    return {
      instanceId: doc.instanceId,
      boardId: doc.boardId,
      boardNombre: doc.boardNombre ?? "",
      columnaTelefono: doc.columnaTelefono,
      plantillas: normalizarPlantillas(doc),
      apiTokenPista: doc.apiTokenPista,
      tieneSigningSecret: doc.signingSecretCifrado !== "",
    };
  }

  /**
   * Quita la conexión: borra el token y el signing secret cifrados. El
   * disparo saliente desde monday queda inactivo hasta reconectar (sin
   * conector, el webhook /webhooks/monday responde 404). No toca los
   * disparadores de entrada, que no dependen del CRM.
   */
  async desconectar(tenantId: TenantId): Promise<void> {
    await this.#repo.deleteConectorMonday(tenantId);
  }

  /** Una página de los boards reales de la cuenta con el token dado (setup). */
  async listarBoards(apiToken: string, pagina = 1): Promise<PaginaBoards> {
    return this.#clienteFactory(apiToken).listarBoards(pagina);
  }

  /** Un board por id con el token dado; null si no existe o el usuario del token no lo ve. */
  async obtenerBoard(apiToken: string, boardId: string): Promise<BoardMonday | null> {
    return this.#clienteFactory(apiToken).obtenerBoard(boardId);
  }

  /** Lista las columnas de un board (para mapear teléfono y variables). */
  async listarColumnas(
    apiToken: string,
    boardId: string,
  ): Promise<ColumnaBoard[]> {
    return this.#clienteFactory(apiToken).listarColumnas(boardId);
  }

  /**
   * Columnas del board YA configurado, usando el token guardado
   * (descifrado en el servidor). Lo usa el editor de Acciones sin que la
   * consola tenga que manejar el token en claro.
   */
  async columnasGuardadas(tenantId: TenantId): Promise<ColumnaBoard[]> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return [];
    const cliente = this.#clienteFactory(
      this.#cripto.descifrar(doc.apiTokenCifrado),
    );
    return cliente.listarColumnas(doc.boardId);
  }

  /**
   * Reemplaza la lista de plantillas, sin tocar credenciales. Conserva el
   * estado de disparo (ultimoDisparoEn/ultimoResultado) de las plantillas
   * que sobreviven, para que el listado no pierda el historial al editar.
   */
  async guardarPlantillas(
    tenantId: TenantId,
    plantillas: PlantillaSaliente[],
  ): Promise<boolean> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return false;
    await this.#repo.saveConectorMonday(tenantId, {
      ...doc,
      plantillas: fusionarPlantillas(normalizarPlantillas(doc), plantillas),
    });
    return true;
  }

  /**
   * Verifica el JWT que monday manda en el header authorization, firmado
   * con el Signing Secret del tenant. true si es válido (o si el tenant
   * no configuró signingSecret, en cuyo caso no se exige).
   */
  verificarFirma(doc: ConectorMondayDoc, authorization: unknown): boolean {
    if (doc.signingSecretCifrado === "") return true;
    if (typeof authorization !== "string" || authorization.length === 0) {
      return false;
    }
    const secreto = this.#cripto.descifrar(doc.signingSecretCifrado);
    const token = authorization.replace(/^Bearer /, "");
    try {
      jwt.verify(token, secreto, { algorithms: ["HS256"] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Procesa un evento de monday: arma el mensaje desde las columnas del
   * item y lo encola. Guarda el vínculo teléfono→item en la conversación
   * para que la respuesta vuelva a ese item. No implementa condiciones:
   * la condición la armó el usuario en la automatización de monday.
   */
  async procesarEvento(
    tenantId: TenantId,
    evento: any,
    plantillaId?: string,
    origen: { ip?: string | null } = {},
  ): Promise<ResultadoDisparo> {
    try {
      const r = await this.#procesarEventoInterno(tenantId, evento, plantillaId, origen);
      const ok = {
        ok: true as const,
        itemId: r.itemId,
        telefono: r.telefono,
        en: new Date().toISOString(),
      };
      await this.#registrarResultado(tenantId, ok);
      await this.#registrarDisparoPlantilla(tenantId, r.plantillaId, ok);
      return r;
    } catch (err: any) {
      if (err instanceof EventoRechazado) {
        // Rechazo: bitácora con IP y motivo. El duplicado no pisa el último
        // resultado de la UI (sería ruido); el item fuera del tablero sí,
        // porque el cliente debe verlo.
        registrar("monday.rechazado", { tenant: tenantId, plantilla: plantillaId ?? "default", item: evento?.pulseId ?? evento?.itemId ?? null, ip: origen.ip ?? null, motivo: err.motivo, detalle: err.message }, "warn");
        if (err.motivo === "duplicado") throw err;
      }
      // El error queda visible en la UI (Salientes), no solo en logs.
      const fail = {
        ok: false as const,
        error: err?.message ?? "error desconocido",
        en: new Date().toISOString(),
      };
      await this.#registrarResultado(tenantId, fail);
      await this.#registrarDisparoPlantilla(tenantId, plantillaId, fail);
      throw err;
    }
  }

  async #procesarEventoInterno(
    tenantId: TenantId,
    evento: any,
    plantillaId?: string,
    origen: { ip?: string | null } = {},
  ): Promise<ResultadoDisparo> {
    void origen;
    const itemId = evento?.pulseId ?? evento?.itemId;
    if (itemId === undefined || itemId === null) {
      throw new EventoRechazado("sin_item", "evento de monday sin pulseId");
    }
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) throw new Error("tenant sin conector monday configurado");

    const plantilla = this.#elegirPlantilla(doc, plantillaId);
    if (!plantilla) {
      throw new Error(
        `la plantilla ${plantillaId ?? "(por defecto)"} no existe en este conector`,
      );
    }

    // Endurecimiento (la URL es lo único que protege el webhook):
    // 1. El item debe ser del tablero configurado. Primero lo que dice el
    //    evento (barato, pero lo controla quien llama); después, lo que dice
    //    la API del item, que es la verdad.
    const boardEvento = evento?.boardId !== undefined && evento?.boardId !== null ? String(evento.boardId) : null;
    if (boardEvento && boardEvento !== doc.boardId) {
      throw new EventoRechazado("item_fuera_del_tablero", `el evento viene del tablero ${boardEvento}, no del configurado (${doc.boardId})`);
    }
    // 2. El mismo item no dispara la misma plantilla dos veces en la ventana.
    const claveDedup = `${tenantId}/${plantilla.id}/${itemId}`;
    const ahora = this.#ahora();
    const previo = this.#recientes.get(claveDedup);
    if (previo !== undefined && ahora - previo < DEDUP_VENTANA_MS) {
      throw new EventoRechazado("duplicado", `el item ${itemId} ya disparó la plantilla ${plantilla.id} hace ${Math.round((ahora - previo) / 1000)} s (ventana ${DEDUP_VENTANA_MS / 60_000} min)`);
    }
    if (this.#recientes.size > 5_000) {
      for (const [k, t] of this.#recientes) if (ahora - t >= DEDUP_VENTANA_MS) this.#recientes.delete(k);
    }

    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.apiTokenCifrado));
    const item = await cliente.getItem(String(itemId));
    if (!item) throw new Error(`item ${itemId} no encontrado en monday`);
    if (item.boardId && item.boardId !== doc.boardId) {
      await this.#registrarFallido(tenantId, doc.instanceId, "—", "", "item_fuera_del_tablero", `El item "${item.name}" es del tablero ${item.boardId}, no del configurado (${doc.boardNombre || doc.boardId}). Solo se disparan items de ese tablero.`);
      throw new EventoRechazado("item_fuera_del_tablero", `el item ${itemId} es del tablero ${item.boardId}, no del configurado (${doc.boardId})`);
    }

    const telefonoTexto = item.columnas[doc.columnaTelefono]?.text ?? "";
    const telefono = soloDigitos(telefonoTexto);
    if (!telefono) {
      await this.#registrarFallido(
        tenantId,
        doc.instanceId,
        "—",
        "",
        "telefono_vacio",
        `El item "${item.name}" no tiene teléfono en la columna mapeada (${doc.columnaTelefono}). Llena esa columna en monday y vuelve a disparar.`,
      );
      throw new Error(
        `el item no tiene teléfono en la columna mapeada (${doc.columnaTelefono})`,
      );
    }
    const cuerpo = renderPlantilla(plantilla.cuerpo, item);
    if (!cuerpo.trim()) {
      await this.#registrarFallido(
        tenantId,
        doc.instanceId,
        `+${telefono}`,
        "",
        "item_incompleto",
        `El item "${item.name}" no tiene los datos que usa la plantilla; el mensaje quedó vacío. Revisa las columnas del item en monday.`,
      );
      throw new Error("la plantilla quedó vacía para este item");
    }

    const mensaje: Message = {
      id: crypto.randomUUID(),
      tenantId,
      instanceId: doc.instanceId,
      direccion: "out",
      origen: "crm",
      telefono: `+${telefono}`,
      cuerpo,
      estado: "encolado",
      externalId: null,
      timestamp: new Date().toISOString(),
    };
    // El ritmo lo pone la cola de envíos (por línea: intervalo + jitter); aquí
    // solo se encola, nunca se rechaza por volumen: 100 recordatorios legítimos
    // salen todos, espaciados.
    await this.#cola.encolar(mensaje);
    this.#recientes.set(claveDedup, this.#ahora());
    await this.#repo.vincularMonday(
      tenantId,
      doc.instanceId,
      telefono,
      String(itemId),
    );
    return {
      itemId: String(itemId),
      telefono,
      mensajeId: mensaje.id,
      plantillaId: plantilla.id,
    };
  }

  /** Elige la plantilla por id; si no se pasa, la por defecto o la primera. */
  #elegirPlantilla(
    doc: ConectorMondayDoc,
    plantillaId?: string,
  ): PlantillaSaliente | null {
    return elegirPlantilla(normalizarPlantillas(doc), plantillaId);
  }

  /** Anota en la plantilla usada cuándo y cómo terminó su último disparo. */
  async #registrarDisparoPlantilla(
    tenantId: TenantId,
    plantillaId: string | undefined,
    resultado: ResultadoPlantilla,
  ): Promise<void> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return;
    const objetivo = this.#elegirPlantilla(doc, plantillaId);
    if (!objetivo) return;
    const plantillas = normalizarPlantillas(doc).map((p) =>
      p.id === objetivo.id
        ? { ...p, ultimoDisparoEn: resultado.en, ultimoResultado: resultado }
        : p,
    );
    await this.#repo.saveConectorMonday(tenantId, { ...doc, plantillas });
  }

  /** Deja un mensaje `fallido` en el registro para que se vea en el dashboard. */
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
      origen: "crm",
      telefono,
      cuerpo,
      estado: "fallido",
      externalId: null,
      error,
      errorCodigo: codigo,
      timestamp: new Date().toISOString(),
    });
  }

  /** Registra que monday golpeó el webhook (para "¿ya me llamó?"). */
  async registrarLlamada(tenantId: TenantId): Promise<void> {
    const previo = await this.#repo.getRegistroMonday(tenantId);
    await this.#repo.setRegistroMonday(tenantId, {
      ultimaLlamadaEn: new Date().toISOString(),
      ultimoResultado: previo?.ultimoResultado ?? null,
    });
  }

  async #registrarResultado(
    tenantId: TenantId,
    resultado: RegistroMonday["ultimoResultado"],
  ): Promise<void> {
    const previo = await this.#repo.getRegistroMonday(tenantId);
    await this.#repo.setRegistroMonday(tenantId, {
      ultimaLlamadaEn: previo?.ultimaLlamadaEn ?? null,
      ultimoResultado: resultado,
    });
  }

  /** Registro observable del conector para la UI. */
  async verRegistro(tenantId: TenantId): Promise<RegistroMonday> {
    return (
      (await this.#repo.getRegistroMonday(tenantId)) ?? {
        ultimaLlamadaEn: null,
        ultimoResultado: null,
      }
    );
  }

  /**
   * Publica un texto como update en un item de monday. Lo usa el motor
   * de entrada cuando llega una respuesta de una conversación vinculada.
   */
  async publicarEnItem(
    tenantId: TenantId,
    itemId: string,
    cuerpo: string,
  ): Promise<void> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return;
    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.apiTokenCifrado));
    await cliente.crearUpdate(itemId, cuerpo);
  }

  /** Item del board configurado cuya columna de teléfono tenga ese número (en cualquiera de sus variantes). */
  async buscarProspecto(tenantId: TenantId, telefono: string): Promise<ProspectoCrm | null> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return null;
    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.apiTokenCifrado));
    const items = await cliente.buscarPorColumna(doc.boardId, doc.columnaTelefono, variantesTelefono(telefono));
    const i = items[0];
    if (!i) return null;
    return { crm: "monday", entidad: "item", id: i.id, nombre: i.nombre, estado: i.grupo, responsable: null, creadoEn: i.creadoEn };
  }
}
