import type { TokensOAuth } from "./tipos.ts";
import { refrescarTokens, tokenVigente, type CredencialesApp } from "./oauth.ts";

/** Error devuelto por el REST de Bitrix, con su código y descripción para poder distinguirlos. */
export class ErrorBitrix extends Error {
  readonly metodo: string;
  readonly codigo: string | null;
  readonly descripcion: string | null;
  constructor(metodo: string, codigo: string | null, descripcion: string | null, status: number) {
    super(`Bitrix no aceptó la llamada (${metodo}): ${descripcion ?? codigo ?? `HTTP ${status}`}`);
    this.name = "ErrorBitrix";
    this.metodo = metodo;
    this.codigo = codigo;
    this.descripcion = descripcion;
  }

  /** event.bind sobre un handler ya enlazado: "Handler already binded". Es el estado deseado, no un fallo. */
  get yaEnlazado(): boolean {
    return /already\s*bind/i.test(this.descripcion ?? "") || /ALREADY/i.test(this.codigo ?? "");
  }
}

const EVENTO_MENSAJES = "OnImConnectorMessageAdd";
const sinBarraFinal = (u: string) => u.trim().replace(/\/+$/, "");

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
      throw new ErrorBitrix(metodo, typeof error === "string" ? error : null, typeof json?.error_description === "string" ? json.error_description : null, res.status);
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

  /** Handlers de eventos que esta app ya tiene registrados en el portal. */
  async listarEventos(): Promise<{ event: string; handler: string }[]> {
    const r = await this.llamar("event.get");
    const lista = Array.isArray(r) ? r : Object.values(r ?? {});
    return lista
      .filter((e: any) => typeof e?.event === "string" && typeof e?.handler === "string")
      .map((e: any) => ({ event: String(e.event), handler: String(e.handler) }));
  }

  /**
   * Paso 2: suscribe el evento de mensajes del operador a nuestro handler.
   * IDEMPOTENTE: una reinstalación (o una segunda instalación en el
   * mismo portal) no debe fallar con "Handler already binded". Primero se
   * consulta event.get; si el handler ya está, no se vuelve a enlazar. Si
   * event.get no está disponible y event.bind contesta que ya estaba,
   * también se da por bueno. Un handler viejo de este mismo evento (otra
   * URL pública) se desenlaza para que los mensajes no se dupliquen ni se
   * pierdan hacia un servidor que ya no es.
   */
  async suscribirMensajes(handler: string): Promise<{ resultado: "enlazado" | "ya_enlazado"; desenlazados: string[] }> {
    const objetivo = sinBarraFinal(handler);
    let existentes: { event: string; handler: string }[] = [];
    try {
      existentes = await this.listarEventos();
    } catch {
      // Sin event.get se intenta el bind directo y se interpreta su respuesta.
    }
    const delEvento = existentes.filter((e) => e.event.toUpperCase() === EVENTO_MENSAJES.toUpperCase());
    const desenlazados: string[] = [];
    for (const e of delEvento) {
      if (sinBarraFinal(e.handler) === objetivo) continue;
      try {
        await this.llamar("event.unbind", { event: EVENTO_MENSAJES, handler: e.handler });
        desenlazados.push(e.handler);
      } catch {
        // No se bloquea la instalación por no poder limpiar un handler viejo; queda en la bitácora del que llama.
      }
    }
    if (delEvento.some((e) => sinBarraFinal(e.handler) === objetivo)) return { resultado: "ya_enlazado", desenlazados };
    try {
      await this.llamar("event.bind", { event: EVENTO_MENSAJES, handler });
      return { resultado: "enlazado", desenlazados };
    } catch (err) {
      if (err instanceof ErrorBitrix && err.yaEnlazado) return { resultado: "ya_enlazado", desenlazados };
      throw err;
    }
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

  // ── Líneas abiertas del portal ─────────────────────────────────────────────

  /** Líneas abiertas existentes en el portal (config.list.get). */
  async listarLineasAbiertas(): Promise<{ id: number; nombre: string; activa: boolean }[]> {
    const r = await this.llamar("imopenlines.config.list.get", {
      PARAMS: { select: ["ID", "LINE_NAME", "ACTIVE"], order: { ID: "asc" }, limit: 200 },
    });
    const lista = Array.isArray(r) ? r : Object.values(r ?? {});
    return lista
      .filter((l: any) => l && Number.isFinite(Number(l.ID)))
      .map((l: any) => ({
        id: Number(l.ID),
        nombre: typeof l.LINE_NAME === "string" && l.LINE_NAME.trim() ? l.LINE_NAME : `Línea ${l.ID}`,
        activa: String(l.ACTIVE ?? "Y").toUpperCase() !== "N",
      }));
  }

  /** Id del usuario con el que actúa la app (`profile` no exige scope aparte). */
  async usuarioActual(): Promise<number | null> {
    try {
      const r = await this.llamar("profile");
      const id = Number(r?.ID);
      return Number.isFinite(id) ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Crea una línea abierta (config.add). Nunca por default: solo cuando el
   * cliente lo pide explícitamente. Activa y con el operador dado como
   * única cola; el equipo se afina en Bitrix.
   */
  async crearLineaAbierta(o: { nombre: string; operadorId: number | null }): Promise<number> {
    const r = await this.llamar("imopenlines.config.add", {
      PARAMS: { LINE_NAME: o.nombre, ACTIVE: "Y", ...(o.operadorId ? { QUEUE: [o.operadorId] } : {}) },
    });
    const id = Number(r);
    if (!Number.isFinite(id)) throw new Error(`imopenlines.config.add no devolvió un id numérico: ${JSON.stringify(r)}`);
    return id;
  }

  /** URL pública del Contact Center del portal (config.path.get), best-effort. */
  async urlContactCenter(): Promise<string | null> {
    try {
      const r = await this.llamar("imopenlines.config.path.get");
      if (typeof r?.SERVER_ADDRESS === "string" && typeof r?.PUBLIC_PATH === "string") {
        return `${r.SERVER_ADDRESS.replace(/\/+$/, "")}${r.PUBLIC_PATH}`;
      }
      return null;
    } catch {
      return null;
    }
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
        crudo: m,
      };
    })
    .filter(Boolean);
  return { connector, line, mensajes };
}
