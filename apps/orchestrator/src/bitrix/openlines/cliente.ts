import type { TokensOAuth } from "./tipos.ts";
import { refrescarTokens, tokenVigente, type CredencialesApp } from "./oauth.ts";

/**
 * Cliente REST de Bitrix24 con OAuth (aplicación local). Distinto del
 * ClienteBitrix por webhook entrante: aquí cada llamada va con
 * `auth=<access_token>` al client_endpoint del portal, y si el token
 * caducó se renueva una vez y se reintenta. Quien nos construye pasa un
 * `alRenovar` para persistir los tokens nuevos cifrados.
 */
export class ClienteOpenlines {
  #tokens: TokensOAuth;
  readonly #cred: CredencialesApp;
  readonly #fetch: typeof fetch;
  readonly #alRenovar: (t: TokensOAuth) => Promise<void>;
  readonly #timeoutMs: number;

  constructor(opciones: {
    tokens: TokensOAuth;
    credenciales: CredencialesApp;
    alRenovar: (t: TokensOAuth) => Promise<void>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#tokens = opciones.tokens;
    this.#cred = opciones.credenciales;
    this.#alRenovar = opciones.alRenovar;
    this.#fetch = opciones.fetchImpl ?? fetch;
    this.#timeoutMs = opciones.timeoutMs ?? 15_000;
  }

  get tokens(): TokensOAuth {
    return this.#tokens;
  }

  async #asegurarToken(forzar = false): Promise<void> {
    if (!forzar && tokenVigente(this.#tokens)) return;
    this.#tokens = await refrescarTokens(this.#tokens, this.#cred, { fetchImpl: this.#fetch });
    await this.#alRenovar(this.#tokens);
  }

  /** Llama un método REST; ante `expired_token` renueva y reintenta una vez. */
  async llamar(metodo: string, params: Record<string, unknown> = {}, reintento = false): Promise<any> {
    await this.#asegurarToken();
    const res = await this.#fetch(`${this.#tokens.clientEndpoint}${metodo}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, auth: this.#tokens.accessToken }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* sin JSON: se reporta por status */ }
    const error = json?.error;
    if ((res.status === 401 || error === "expired_token" || error === "invalid_token") && !reintento) {
      await this.#asegurarToken(true);
      return this.llamar(metodo, params, true);
    }
    if (res.status >= 400 || error) {
      throw new Error(`Bitrix no aceptó la llamada (${metodo}): ${json?.error_description ?? error ?? `HTTP ${res.status}`}`);
    }
    return json?.result;
  }

  // ── Conector de línea abierta ──────────────────────────────────────────────

  /** Paso 1: registra el conector en el portal. */
  registrarConector(o: { id: string; nombre: string; icono: { DATA_IMAGE: string }; placementHandler: string }) {
    return this.llamar("imconnector.register", {
      ID: o.id,
      NAME: o.nombre,
      ICON: o.icono,
      ICON_DISABLED: o.icono,
      PLACEMENT_HANDLER: o.placementHandler,
    });
  }

  /** Paso 2: suscribe el evento de mensajes del operador a nuestro handler. */
  suscribirMensajes(handler: string) {
    return this.llamar("event.bind", { event: "OnImConnectorMessageAdd", handler });
  }

  /** Paso 3a: activa el conector en una línea. */
  activarConector(o: { connector: string; line: number; active: boolean }) {
    return this.llamar("imconnector.activate", { CONNECTOR: o.connector, LINE: o.line, ACTIVE: o.active ? 1 : 0 });
  }

  /** Paso 3b: datos del canal externo que Bitrix muestra en la línea. */
  fijarDatosConector(o: { connector: string; line: number; id: string; nombre: string; urlIm?: string }) {
    return this.llamar("imconnector.connector.data.set", {
      CONNECTOR: o.connector,
      LINE: o.line,
      DATA: { ID: o.id, NAME: o.nombre, ...(o.urlIm ? { URL_IM: o.urlIm } : {}) },
    });
  }

  /**
   * Paso 4: entrega a la línea un mensaje del contacto. `chat.id` es
   * NUESTRO identificador (instancia:teléfono); Bitrix devuelve su
   * session.CHAT_ID y session.ID, que se guardan sin asumirlos.
   */
  async enviarEntrante(o: {
    connector: string;
    line: number;
    chatId: string;
    usuario: { id: string; nombre?: string | null; telefono?: string | null };
    mensaje: { id: string; fecha: Date; texto: string; archivos?: { url: string; nombre: string }[] };
  }): Promise<{ chatId: string | null; sessionId: string | null }> {
    const result = await this.llamar("imconnector.send.messages", {
      CONNECTOR: o.connector,
      LINE: o.line,
      MESSAGES: [
        {
          user: {
            id: o.usuario.id,
            ...(o.usuario.nombre ? { name: o.usuario.nombre } : {}),
            ...(o.usuario.telefono ? { phone: o.usuario.telefono, skip_phone_validate: "Y" } : {}),
          },
          message: {
            id: o.mensaje.id,
            date: Math.floor(o.mensaje.fecha.getTime() / 1000),
            text: o.mensaje.texto,
            ...(o.mensaje.archivos?.length ? { files: o.mensaje.archivos.map((a) => ({ url: a.url, name: a.nombre })) } : {}),
          },
          chat: { id: o.chatId },
        },
      ],
    });
    const r = Array.isArray(result?.DATA?.RESULT) ? result.DATA.RESULT[0] : null;
    return {
      chatId: r?.session?.CHAT_ID != null ? String(r.session.CHAT_ID) : null,
      sessionId: r?.session?.ID != null ? String(r.session.ID) : null,
    };
  }

  /** Paso 5: confirma a Bitrix que el mensaje del operador salió por WhatsApp. */
  confirmarEntrega(o: { connector: string; line: number; imChatId: number; imMessageId: number; chatId: string; externalId: string; fecha?: Date }) {
    return this.llamar("imconnector.send.status.delivery", {
      CONNECTOR: o.connector,
      LINE: o.line,
      MESSAGES: [
        {
          im: { chat_id: o.imChatId, message_id: o.imMessageId },
          message: { id: [o.externalId], date: Math.floor((o.fecha ?? new Date()).getTime() / 1000) },
          chat: { id: o.chatId },
        },
      ],
    });
  }

  // ── imbot: para que las respuestas del bot se vean del lado del operador ──
  // Se verifica en el dogfooding antes de construir la ventana humana.

  registrarBot(o: { codigo: string; nombre: string; handler: string }) {
    return this.llamar("imbot.register", {
      CODE: o.codigo,
      TYPE: "O", // bot de línea abierta
      EVENT_HANDLER: o.handler,
      OPENLINE: "Y",
      PROPERTIES: { NAME: o.nombre, COLOR: "AQUA" },
    });
  }

  /** Escribe en el chat de la sesión del lado interno (operador). */
  mensajeDeBot(o: { botId: number; imChatId: number; texto: string }) {
    return this.llamar("imbot.message.add", { BOT_ID: o.botId, DIALOG_ID: `chat${o.imChatId}`, MESSAGE: o.texto });
  }
}

/**
 * Interpreta el payload de OnImConnectorMessageAdd. Los adjuntos no están
 * documentados en el evento; se buscan de forma defensiva en
 * `message.files` para poder decidir (v1: no se entregan, se registra).
 */
export function interpretarEventoMensajes(data: any): {
  connector: string | null;
  line: number | null;
  mensajes: import("./tipos.ts").MensajeOperador[];
} {
  const connector = typeof data?.CONNECTOR === "string" ? data.CONNECTOR : null;
  const line = data?.LINE != null && Number.isFinite(Number(data.LINE)) ? Number(data.LINE) : null;
  const lista = Array.isArray(data?.MESSAGES) ? data.MESSAGES : Object.values(data?.MESSAGES ?? {});
  const mensajes = lista
    .map((m: any) => {
      const chatExternoId = m?.chat?.id != null ? String(m.chat.id) : null;
      const imChatId = Number(m?.im?.chat_id);
      const imMessageId = Number(m?.im?.message_id);
      if (!chatExternoId || !Number.isFinite(imChatId) || !Number.isFinite(imMessageId)) return null;
      const archivosCrudos = Array.isArray(m?.message?.files) ? m.message.files : Object.values(m?.message?.files ?? {});
      return {
        chatExternoId,
        imChatId,
        imMessageId,
        texto: typeof m?.message?.text === "string" ? m.message.text : "",
        userId: m?.message?.user_id != null && Number.isFinite(Number(m.message.user_id)) ? Number(m.message.user_id) : null,
        archivos: archivosCrudos
          .map((a: any) => (typeof a?.url === "string" ? { url: a.url, nombre: typeof a?.name === "string" ? a.name : null } : null))
          .filter(Boolean),
      };
    })
    .filter(Boolean);
  return { connector, line, mensajes };
}
