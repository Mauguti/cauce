import jwt from "jsonwebtoken";
import type { Message, TenantId } from "@cauce/core";
import type { ColaEnvios } from "../cola.ts";
import type { Repositorio } from "../store.ts";
import { Cripto, pista } from "../cripto.ts";
import { ClienteMonday, type BoardMonday, type ColumnaBoard, type ItemMonday } from "./cliente.ts";

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
  /** columnId de monday que contiene el teléfono del cliente. */
  columnaTelefono: string;
  /**
   * Plantilla del mensaje. Variables: {{columnId}} se reemplaza por el
   * texto de esa columna, {{nombre}} por el nombre del item.
   */
  plantilla: string;
  /** API token de monday, cifrado. */
  apiTokenCifrado: string;
  /** Signing Secret de la app de monday, cifrado ("" si no se configuró). */
  signingSecretCifrado: string;
  /** Últimos caracteres del API token, en claro, para la UI. */
  apiTokenPista: string;
}

/** Datos en claro que la consola envía para dar de alta el conector. */
export interface AltaConectorMonday {
  instanceId: string;
  boardId: string;
  columnaTelefono: string;
  plantilla: string;
  apiToken: string;
  signingSecret: string;
}

/** Reemplaza {{nombre}} y {{columnId}} por los valores del item. */
export function renderPlantilla(plantilla: string, item: ItemMonday): string {
  return plantilla.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, clave: string) => {
    if (clave === "nombre") return item.name;
    return item.columnas[clave]?.text ?? "";
  });
}

/** Normaliza un teléfono a solo dígitos (E.164 sin '+'). */
function soloDigitos(telefono: string): string {
  return telefono.replace(/[^\d]/g, "");
}

export interface ResultadoDisparo {
  itemId: string;
  telefono: string;
  mensajeId: string;
}

export class ConectorMonday {
  readonly #repo: Repositorio;
  readonly #cola: ColaEnvios;
  readonly #cripto: Cripto;
  readonly #clienteFactory: (token: string) => ClienteMonday;

  constructor(opciones: {
    repo: Repositorio;
    cola: ColaEnvios;
    cripto?: Cripto;
    /** Inyectable para pruebas. */
    clienteFactory?: (token: string) => ClienteMonday;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola;
    this.#cripto = opciones.cripto ?? new Cripto();
    this.#clienteFactory =
      opciones.clienteFactory ?? ((token) => new ClienteMonday(token));
  }

  /** Cifra las credenciales del alta y las guarda. */
  async guardarAlta(tenantId: TenantId, alta: AltaConectorMonday): Promise<void> {
    await this.#repo.saveConectorMonday(tenantId, {
      instanceId: alta.instanceId,
      boardId: alta.boardId,
      columnaTelefono: alta.columnaTelefono,
      plantilla: alta.plantilla,
      apiTokenCifrado: this.#cripto.cifrar(alta.apiToken),
      signingSecretCifrado: this.#cripto.cifrar(alta.signingSecret),
      apiTokenPista: pista(alta.apiToken),
    });
  }

  /** Vista de la config para la UI: sin secretos, solo la pista del token. */
  async verConfig(tenantId: TenantId): Promise<{
    instanceId: string;
    boardId: string;
    columnaTelefono: string;
    plantilla: string;
    apiTokenPista: string;
    tieneSigningSecret: boolean;
  } | null> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return null;
    return {
      instanceId: doc.instanceId,
      boardId: doc.boardId,
      columnaTelefono: doc.columnaTelefono,
      plantilla: doc.plantilla,
      apiTokenPista: doc.apiTokenPista,
      tieneSigningSecret: doc.signingSecretCifrado !== "",
    };
  }

  /** Lista los boards reales de la cuenta con el token dado (setup). */
  async listarBoards(apiToken: string): Promise<BoardMonday[]> {
    return this.#clienteFactory(apiToken).listarBoards();
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

  /** Actualiza solo la plantilla, sin tocar credenciales. */
  async actualizarPlantilla(
    tenantId: TenantId,
    plantilla: string,
  ): Promise<boolean> {
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) return false;
    await this.#repo.saveConectorMonday(tenantId, { ...doc, plantilla });
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
  ): Promise<ResultadoDisparo> {
    const itemId = evento?.pulseId ?? evento?.itemId;
    if (itemId === undefined || itemId === null) {
      throw new Error("evento de monday sin pulseId");
    }
    const doc = await this.#repo.getConectorMonday(tenantId);
    if (!doc) throw new Error("tenant sin conector monday configurado");

    const cliente = this.#clienteFactory(this.#cripto.descifrar(doc.apiTokenCifrado));
    const item = await cliente.getItem(String(itemId));
    if (!item) throw new Error(`item ${itemId} no encontrado en monday`);

    const telefonoTexto = item.columnas[doc.columnaTelefono]?.text ?? "";
    const telefono = soloDigitos(telefonoTexto);
    if (!telefono) {
      throw new Error(
        `item ${itemId} sin teléfono en la columna ${doc.columnaTelefono}`,
      );
    }
    const cuerpo = renderPlantilla(doc.plantilla, item);

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
    await this.#repo.vincularMonday(
      tenantId,
      doc.instanceId,
      telefono,
      String(itemId),
    );
    return { itemId: String(itemId), telefono, mensajeId: mensaje.id };
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
}
