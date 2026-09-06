import jwt from "jsonwebtoken";
import type { Message, TenantId } from "@cauce/core";
import type { ColaEnvios } from "../cola.ts";
import type { Repositorio } from "../store.ts";
import { ClienteMonday, type ItemMonday } from "./cliente.ts";

/**
 * Configuración del conector monday por tenant. Se guarda en el
 * repositorio; el apiToken y el signingSecret son secretos.
 */
export interface ConfigMonday {
  /** Instancia (número) desde la que se envían los mensajes del tenant. */
  instanceId: string;
  /** API token de monday del tenant (para leer items y escribir updates). */
  apiToken: string;
  /**
   * Signing Secret de la app de monday, para verificar el JWT que monday
   * manda en el header authorization. Vacío = no se exige JWT (se
   * confía solo en el token de path; ver más abajo).
   */
  signingSecret: string;
  /** columnId de monday que contiene el teléfono del cliente. */
  columnaTelefono: string;
  /**
   * Plantilla del mensaje. Variables: {{columnId}} se reemplaza por el
   * texto de esa columna, {{nombre}} por el nombre del item.
   */
  plantilla: string;
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
  readonly #clienteFactory: (token: string) => ClienteMonday;

  constructor(opciones: {
    repo: Repositorio;
    cola: ColaEnvios;
    /** Inyectable para pruebas. */
    clienteFactory?: (token: string) => ClienteMonday;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola;
    this.#clienteFactory =
      opciones.clienteFactory ?? ((token) => new ClienteMonday(token));
  }

  /**
   * Verifica el JWT que monday manda en el header authorization, firmado
   * con el Signing Secret del tenant. Devuelve true si es válido (o si
   * el tenant no configuró signingSecret, en cuyo caso no se exige).
   */
  verificarFirma(config: ConfigMonday, authorization: unknown): boolean {
    if (!config.signingSecret) return true; // gate por token de path
    if (typeof authorization !== "string" || authorization.length === 0) {
      return false;
    }
    const token = authorization.replace(/^Bearer /, "");
    try {
      jwt.verify(token, config.signingSecret, { algorithms: ["HS256"] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Procesa un evento de monday: arma el mensaje desde las columnas del
   * item y lo encola. Registra el vínculo teléfono→item para que la
   * respuesta del cliente vuelva a ese item. No implementa condiciones:
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
    const config = await this.#repo.getConectorMonday(tenantId);
    if (!config) throw new Error("tenant sin conector monday configurado");

    const cliente = this.#clienteFactory(config.apiToken);
    const item = await cliente.getItem(String(itemId));
    if (!item) throw new Error(`item ${itemId} no encontrado en monday`);

    const telefonoTexto = item.columnas[config.columnaTelefono]?.text ?? "";
    const telefono = soloDigitos(telefonoTexto);
    if (!telefono) {
      throw new Error(
        `item ${itemId} sin teléfono en la columna ${config.columnaTelefono}`,
      );
    }
    const cuerpo = renderPlantilla(config.plantilla, item);

    const mensaje: Message = {
      id: crypto.randomUUID(),
      tenantId,
      instanceId: config.instanceId,
      direccion: "out",
      telefono: `+${telefono}`,
      cuerpo,
      estado: "encolado",
      externalId: null,
      timestamp: new Date().toISOString(),
    };
    await this.#cola.encolar(mensaje);
    // El vínculo con el item vive en la conversación (identidad estable):
    // la respuesta desde este teléfono sabrá a qué item volver.
    await this.#repo.vincularMonday(
      tenantId,
      config.instanceId,
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
    const config = await this.#repo.getConectorMonday(tenantId);
    if (!config) return;
    const cliente = this.#clienteFactory(config.apiToken);
    await cliente.crearUpdate(itemId, cuerpo);
  }
}
