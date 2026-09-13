import { randomUUID } from "node:crypto";
import {
  canalAbiertoDe,
  type Conversacion,
  type InstanceId,
  type Message,
  type TenantId,
} from "@cauce/core";
import type { Repositorio } from "../../store.ts";
import type { ColaEnvios } from "../../cola.ts";
import { Cripto } from "../../cripto.ts";
import { enmascararTelefono, registrar, registrarError } from "../../log.ts";
import { ClienteOpenlines, interpretarEventoMensajes } from "./cliente.ts";
import { tokensDesdeAuth, type CredencialesApp } from "./oauth.ts";
import { LimitadorInmediato } from "./limitador.ts";
import { chatExterno, partirChatExterno, type OpenlinesBitrixDoc, type TokensOAuth } from "./tipos.ts";

/** Envío por el carril inmediato (sin cola); lo provee el gestor de sesiones. */
export type EnviarInmediato = (
  tenantId: TenantId,
  instanceId: InstanceId,
  telefono: string,
  cuerpo: string,
) => Promise<Message>;

export interface AltaOpenlines {
  instanceId: InstanceId;
  clientId: string;
  clientSecret: string;
  /** Dominio del portal de Bitrix24 del cliente, p. ej. digsol.bitrix24.mx. */
  dominio: string;
}

/** Normaliza lo que el usuario pegue: URL completa, con barra, mayúsculas… → solo el host. */
export function normalizarDominioPortal(entrada: string): string {
  const s = entrada.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{2,}\.[a-z]{2,}$/.test(s)) {
    throw new Error("el dominio del portal no es válido; ejemplo: tuempresa.bitrix24.mx");
  }
  return s;
}

const ICONO_SVG =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#25D366"/><path d="M12 28l2-5a9 9 0 1 1 3 3z" fill="#fff"/></svg>`,
  ).toString("base64");

/**
 * Canal abierto de Bitrix24: conecta una línea de WhatsApp al Contact
 * Center de un portal. Aparte del conector Bitrix por webhook; conviven.
 *
 * Secretos: client_id/client_secret de la app local y los tokens OAuth
 * viven CIFRADOS en Firestore con la misma Cripto que las credenciales de
 * CRM. Un solo mecanismo; dar de alta un cliente no exige reiniciar ni
 * desplegar.
 */
export class ConectorOpenlines {
  readonly #repo: Repositorio;
  readonly #cola: ColaEnvios | null;
  readonly #cripto: Cripto;
  readonly #enviar: EnviarInmediato;
  readonly #urlPublica: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #limitador = new LimitadorInmediato();
  readonly #dormir: (ms: number) => Promise<void>;

  constructor(opciones: {
    repo: Repositorio;
    enviarInmediato: EnviarInmediato;
    /** Base pública del orquestador (p. ej. https://api.factory.digsol.com.mx). */
    urlPublica: string;
    cola?: ColaEnvios;
    cripto?: Cripto;
    fetchImpl?: typeof fetch;
    dormir?: (ms: number) => Promise<void>;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola ?? null;
    this.#cripto = opciones.cripto ?? new Cripto();
    this.#enviar = opciones.enviarInmediato;
    this.#urlPublica = opciones.urlPublica.replace(/\/+$/, "");
    this.#fetch = opciones.fetchImpl;
    this.#dormir = opciones.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** URL única del tenant para instalación, placement y eventos. */
  urlHandler(tenantId: TenantId): string {
    return `${this.#urlPublica}/bitrix/openlines/${tenantId}`;
  }

  connectorId(tenantId: TenantId): string {
    return `digsol_factory_${tenantId}`;
  }

  // ── Alta desde la plataforma ─────────────────────────────────────────────

  /** Guarda la app local (client_id/secret cifrados) y deja el conector pendiente de instalación. */
  async guardarAlta(tenantId: TenantId, alta: AltaOpenlines): Promise<OpenlinesBitrixDoc> {
    if (!alta.clientId.trim() || !alta.clientSecret.trim()) {
      throw new Error("se requieren client_id y client_secret de la aplicación local de Bitrix24");
    }
    const dominio = normalizarDominioPortal(alta.dominio);
    const previo = await this.#repo.getOpenlinesBitrix(tenantId);
    const ahora = new Date().toISOString();
    const doc: OpenlinesBitrixDoc = {
      instanceId: alta.instanceId,
      connectorId: this.connectorId(tenantId),
      lineId: previo?.lineId ?? null,
      activo: previo?.activo ?? false,
      tokensCifrados: previo?.tokensCifrados ?? "",
      appCifrada: this.#cripto.cifrar(JSON.stringify({ clientId: alta.clientId.trim(), clientSecret: alta.clientSecret.trim() })),
      dominio,
      botId: previo?.botId ?? null,
      instaladoEn: previo?.instaladoEn ?? null,
      actualizadoEn: ahora,
    };
    await this.#repo.saveOpenlinesBitrix(tenantId, doc);
    registrar("openlines.alta", { tenant: tenantId, instancia: alta.instanceId, dominio, resultado: previo ? "editada" : "creada" });
    return doc;
  }

  async ver(tenantId: TenantId) {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc) return null;
    return {
      instanceId: doc.instanceId,
      connectorId: doc.connectorId,
      lineId: doc.lineId,
      activo: doc.activo,
      instalada: doc.tokensCifrados !== "",
      dominio: doc.dominio,
      botId: doc.botId,
      instaladoEn: doc.instaladoEn,
      actualizadoEn: doc.actualizadoEn,
      urlHandler: this.urlHandler(tenantId),
    };
  }

  async quitar(tenantId: TenantId): Promise<void> {
    await this.#repo.deleteOpenlinesBitrix(tenantId);
    registrar("openlines.baja", { tenant: tenantId });
  }

  // ── Handler de Bitrix (instalación, placement, eventos) ──────────────────

  #credenciales(doc: OpenlinesBitrixDoc): CredencialesApp {
    return JSON.parse(this.#cripto.descifrar(doc.appCifrada)) as CredencialesApp;
  }

  #tokens(doc: OpenlinesBitrixDoc): TokensOAuth {
    if (!doc.tokensCifrados) throw new Error("la aplicación aún no se ha instalado en el portal");
    return JSON.parse(this.#cripto.descifrar(doc.tokensCifrados)) as TokensOAuth;
  }

  #cliente(tenantId: TenantId, doc: OpenlinesBitrixDoc): ClienteOpenlines {
    return new ClienteOpenlines({
      tokens: this.#tokens(doc),
      credenciales: this.#credenciales(doc),
      ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      alRenovar: async (t) => {
        const actual = (await this.#repo.getOpenlinesBitrix(tenantId)) ?? doc;
        await this.#repo.saveOpenlinesBitrix(tenantId, {
          ...actual,
          tokensCifrados: this.#cripto.cifrar(JSON.stringify(t)),
          actualizadoEn: new Date().toISOString(),
        });
        registrar("openlines.token_renovado", { tenant: tenantId, dominio: t.dominio });
      },
    });
  }

  /**
   * ONAPPINSTALL: Bitrix instaló la app en el portal y nos manda los
   * tokens. Solo se acepta si el tenant dio de alta la app antes; si ya
   * había una instalación, el portal (member_id) debe coincidir.
   */
  async instalar(tenantId: TenantId, auth: unknown): Promise<void> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc) throw new Error("tenant sin canal abierto dado de alta");
    const tokens = tokensDesdeAuth(auth);
    const rechazar = (motivo: string): never => {
      registrar("openlines.instalacion_rechazada", { tenant: tenantId, dominio: tokens.dominio, motivo }, "warn");
      throw new Error(`instalación rechazada: ${motivo}`);
    };
    // 1. El portal debe ser el que el tenant declaró al dar de alta, y el
    //    endpoint REST debe vivir en ese mismo host: nada de tokens que
    //    apunten a un servidor ajeno.
    const dominioRecibido = tokens.dominio.trim().toLowerCase();
    if (dominioRecibido !== doc.dominio) rechazar("el portal no es el declarado en el alta");
    let hostEndpoint = "";
    try { hostEndpoint = new URL(tokens.clientEndpoint).host.toLowerCase(); } catch { rechazar("client_endpoint inválido"); }
    if (hostEndpoint !== doc.dominio) rechazar("client_endpoint no corresponde al portal declarado");
    if (!tokens.clientEndpoint.startsWith("https://")) rechazar("client_endpoint sin HTTPS");
    // 2. Si ya había instalación, debe ser el mismo portal (member_id).
    if (doc.tokensCifrados) {
      const previos = this.#tokens(doc);
      if (previos.memberId !== tokens.memberId) rechazar("la aplicación ya está instalada en otro portal");
    }
    // 3. El token debe ser de NUESTRA app local: app.info en el portal
    //    declarado debe devolver el client_id que el tenant dio de alta.
    const instalado: OpenlinesBitrixDoc = {
      ...doc,
      tokensCifrados: this.#cripto.cifrar(JSON.stringify(tokens)),
      instaladoEn: doc.instaladoEn ?? new Date().toISOString(),
      actualizadoEn: new Date().toISOString(),
    };
    const cliente = this.#cliente(tenantId, instalado);
    const info = await cliente.llamar("app.info");
    const codigo = String(info?.CODE ?? info?.code ?? "").toLowerCase();
    const esperado = this.#credenciales(doc).clientId.toLowerCase();
    if (!codigo || codigo !== esperado) {
      registrar("openlines.instalacion_rechazada", {
        tenant: tenantId, dominio: tokens.dominio, motivo: "app.info no corresponde a la app dada de alta",
        campos: Object.keys(info ?? {}).join(","),
      }, "warn");
      throw new Error("instalación rechazada: el token no es de la aplicación local dada de alta");
    }
    await this.#repo.saveOpenlinesBitrix(tenantId, instalado);
    const handler = this.urlHandler(tenantId);
    await cliente.registrarConector({
      id: instalado.connectorId,
      nombre: "WhatsApp · Digsol Factory",
      icono: { DATA_IMAGE: ICONO_SVG },
      placementHandler: handler,
    });
    await cliente.suscribirMensajes(handler);
    registrar("openlines.instalada", { tenant: tenantId, dominio: tokens.dominio, conector: instalado.connectorId });
  }

  /** ¿El evento viene del portal instalado? Compara application_token. */
  async eventoAutentico(tenantId: TenantId, auth: any): Promise<boolean> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc?.tokensCifrados) return false;
    const tokens = this.#tokens(doc);
    const recibido = auth?.application_token;
    return typeof recibido === "string" && recibido.length > 0 && recibido === tokens.applicationToken;
  }

  /** Placement SETTING_CONNECTOR: Bitrix abre nuestra página con LINE y ACTIVE_STATUS. */
  async activar(tenantId: TenantId, opciones: { line: number; activo: boolean; memberId?: string | null }): Promise<OpenlinesBitrixDoc> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc) throw new Error("tenant sin canal abierto dado de alta");
    const tokens = this.#tokens(doc);
    // Sin member_id o con uno distinto, no se toca nada: un POST desde
    // fuera podría desactivar o redirigir la línea de un cliente.
    if (!opciones.memberId || opciones.memberId !== tokens.memberId) {
      registrar("openlines.placement_rechazado", { tenant: tenantId, linea: opciones.line, motivo: opciones.memberId ? "member_id distinto" : "sin member_id" }, "warn");
      throw new Error("el placement no viene del portal instalado");
    }
    const cliente = this.#cliente(tenantId, doc);
    await cliente.activarConector({ connector: doc.connectorId, line: opciones.line, active: opciones.activo });
    if (opciones.activo) {
      await cliente.fijarDatosConector({
        connector: doc.connectorId,
        line: opciones.line,
        id: doc.instanceId,
        nombre: "WhatsApp · Digsol Factory",
      });
    }
    const actualizado: OpenlinesBitrixDoc = { ...doc, lineId: opciones.line, activo: opciones.activo, actualizadoEn: new Date().toISOString() };
    await this.#repo.saveOpenlinesBitrix(tenantId, actualizado);
    registrar("openlines.activacion", { tenant: tenantId, linea: opciones.line, resultado: opciones.activo ? "activo" : "inactivo" });
    return actualizado;
  }

  /**
   * Registra el imbot de línea abierta y guarda su id. Es la pieza de la
   * prueba de visibilidad: con bot registrado, las respuestas de los bots
   * se reflejan en el chat del operador y sus eventos se reconocen para
   * no rebotar al contacto. Si la prueba falla, se quita y se cae a C.
   */
  async registrarBot(tenantId: TenantId): Promise<number> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc) throw new Error("tenant sin canal abierto dado de alta");
    const cliente = this.#cliente(tenantId, doc);
    const resultado = await cliente.registrarBot({
      codigo: `digsol_factory_bot_${tenantId}`,
      nombre: "Bot · Digsol Factory",
      handler: this.urlHandler(tenantId),
    });
    const botId = Number(resultado);
    if (!Number.isFinite(botId)) throw new Error(`imbot.register no devolvió un id numérico: ${JSON.stringify(resultado)}`);
    await this.#repo.saveOpenlinesBitrix(tenantId, { ...doc, botId, actualizadoEn: new Date().toISOString() });
    registrar("openlines.bot_registrado", { tenant: tenantId, botId });
    return botId;
  }

  // ── Entrante: WhatsApp → Contact Center ──────────────────────────────────

  /**
   * Manda a la línea abierta un mensaje que llegó a la instancia del
   * canal. Devuelve false si el canal no aplica a esta instancia. Nunca
   * lanza hacia el webhook: el fallo queda en la bitácora.
   */
  async entrante(tenantId: TenantId, instanceId: InstanceId, mensaje: Message, nombre?: string | null): Promise<boolean> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc || !doc.activo || doc.lineId === null || doc.instanceId !== instanceId) return false;
    const telefono = mensaje.telefono.replace(/[^\d]/g, "");
    const chatId = chatExterno(instanceId, telefono);
    try {
      const cliente = this.#cliente(tenantId, doc);
      const r = await cliente.enviarEntrante({
        connector: doc.connectorId,
        line: doc.lineId,
        chatId,
        usuario: { id: telefono, nombre: nombre ?? null, telefono: `+${telefono}` },
        mensaje: { id: mensaje.id, fecha: new Date(mensaje.timestamp), texto: mensaje.cuerpo },
      });
      await this.#repo.vincularOpenLine(tenantId, instanceId, telefono, {
        lineId: doc.lineId,
        chatId: r.chatId,
        sessionId: r.sessionId,
        actualizadoEn: new Date().toISOString(),
      });
      registrar("openlines.entrante", {
        tenant: tenantId, instancia: instanceId, mensaje: mensaje.id, telefono: enmascararTelefono(mensaje.telefono),
        linea: doc.lineId, chatBitrix: r.chatId, sesionBitrix: r.sessionId, resultado: "ok",
      });
      return true;
    } catch (err) {
      registrarError("openlines.entrante", err, {
        tenant: tenantId, instancia: instanceId, mensaje: mensaje.id, telefono: enmascararTelefono(mensaje.telefono),
      });
      return false;
    }
  }

  /** ¿Esta conversación está en ventana humana ahora? */
  static enVentanaHumana(c: Conversacion | null, ahora: Date = new Date()): boolean {
    return Boolean(c?.humanaHasta && new Date(c.humanaHasta) > ahora);
  }

  /**
   * Espejo de la respuesta de un bot en el chat de la sesión, del lado del
   * operador, vía imbot. Solo si el bot está registrado. Best-effort: se
   * verifica en el dogfooding que NO rebote al contacto.
   */
  async reflejarBot(tenantId: TenantId, instanceId: InstanceId, telefono: string, texto: string): Promise<void> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc || !doc.activo || doc.instanceId !== instanceId || doc.botId === null) return;
    const conv = await this.#repo.getConversacion(tenantId, instanceId, telefono.replace(/[^\d]/g, ""));
    const imChatId = conv?.bitrixOpenLine?.chatId ? Number(conv.bitrixOpenLine.chatId) : null;
    if (!imChatId) return;
    try {
      await this.#cliente(tenantId, doc).mensajeDeBot({ botId: doc.botId, imChatId, texto: `🤖 ${texto}` });
      registrar("openlines.bot_reflejado", { tenant: tenantId, instancia: instanceId, chatBitrix: imChatId });
    } catch (err) {
      registrarError("openlines.bot_reflejado", err, { tenant: tenantId, instancia: instanceId });
    }
  }

  // ── Saliente: operador → WhatsApp ────────────────────────────────────────

  /**
   * OnImConnectorMessageAdd: el operador escribió. Va por el carril
   * inmediato con espaciado por conversación y tope de ráfaga por línea
   * (el excedente a la cola normal, registrado). Confirma la entrega a
   * Bitrix y abre/renueva la ventana humana. Los mensajes del propio
   * imbot se ignoran para que no reboten al contacto.
   */
  async respuestaOperador(tenantId: TenantId, data: unknown): Promise<void> {
    const doc = await this.#repo.getOpenlinesBitrix(tenantId);
    if (!doc || !doc.activo || doc.lineId === null) {
      registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "canal inactivo" }, "warn");
      return;
    }
    const { connector, line, mensajes } = interpretarEventoMensajes(data);
    if (connector !== doc.connectorId || line !== doc.lineId) {
      registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "conector o línea distintos", conector: connector, linea: line }, "warn");
      return;
    }
    const tenant = await this.#repo.getTenant(tenantId);
    const cfg = canalAbiertoDe(tenant ?? {});
    const cliente = this.#cliente(tenantId, doc);

    for (const m of mensajes) {
      if (doc.botId !== null && m.userId === doc.botId) {
        registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "mensaje del propio bot", imMensaje: m.imMessageId });
        continue;
      }
      const partes = partirChatExterno(m.chatExternoId);
      if (!partes || partes.instanceId !== doc.instanceId) {
        registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "chat externo no reconocido", chat: m.chatExternoId }, "warn");
        continue;
      }
      const { instanceId, telefono } = partes;
      const base = { tenant: tenantId, instancia: instanceId, telefono: enmascararTelefono(telefono), imMensaje: m.imMessageId, usuario: m.userId };

      if (!m.texto.trim()) {
        // v1 solo texto: no se entrega ni se confirma; Bitrix lo mostrará como no entregado.
        registrar("openlines.adjunto_no_soportado", { ...base, archivos: m.archivos.length }, "warn");
        continue;
      }

      const clave = `${tenantId}/${instanceId}/${telefono}`;
      const hasta = new Date(Date.now() + cfg.ventanaHumanaMin * 60_000).toISOString();

      if (this.#limitador.rafagaSuperada(instanceId, cfg.rafagaN, cfg.rafagaSeg)) {
        // Excedente a la cola normal, con su espaciado. No se descarta.
        if (this.#cola) {
          await this.#cola.encolar({
            id: randomUUID(), tenantId, instanceId, direccion: "out", telefono: `+${telefono}`,
            cuerpo: m.texto, estado: "encolado", externalId: null, timestamp: new Date().toISOString(),
          });
        }
        registrar("openlines.rafaga", { ...base, tope: `${cfg.rafagaN}/${cfg.rafagaSeg}s`, resultado: this.#cola ? "encolado" : "sin cola: descartado" }, "warn");
        await this.#repo.marcarHumana(tenantId, instanceId, telefono, hasta);
        continue;
      }

      const espera = this.#limitador.esperaPara(clave, cfg.espaciadoMs);
      if (espera > 0) await this.#dormir(espera);

      try {
        const enviado = await this.#enviar(tenantId, instanceId, `+${telefono}`, m.texto);
        this.#limitador.registrar(clave, instanceId);
        await this.#repo.marcarHumana(tenantId, instanceId, telefono, hasta);
        if (enviado.estado === "enviado") {
          await cliente.confirmarEntrega({
            connector: doc.connectorId, line: doc.lineId, imChatId: m.imChatId, imMessageId: m.imMessageId,
            chatId: m.chatExternoId, externalId: enviado.externalId ?? enviado.id,
          });
          registrar("openlines.operador", { ...base, mensaje: enviado.id, resultado: "entregado", humanaHasta: hasta });
        } else {
          registrar("openlines.operador", { ...base, mensaje: enviado.id, resultado: enviado.estado, error: enviado.error ?? null }, "warn");
        }
      } catch (err) {
        registrarError("openlines.operador", err, base);
      }
    }
  }
}
