import { randomUUID } from "node:crypto";
import {
  canalAbiertoDe,
  type Conversacion,
  type Instance,
  type InstanceId,
  type Message,
  type TenantId,
} from "@cauce/core";
import type { Repositorio } from "../../store.ts";
import type { ColaEnvios } from "../../cola.ts";
import { Cripto } from "../../cripto.ts";
import { enmascararTelefono, registrar, registrarError } from "../../log.ts";
import { resumirCrudo } from "../../webhook.ts";
import { ClienteOpenlines, ErrorBitrix, interpretarEventoMensajes } from "./cliente.ts";
import { tokensDesdeAuth, type CredencialesApp } from "./oauth.ts";
import { LimitadorInmediato } from "./limitador.ts";
import { htmlPlacement, htmlRechazo, type AvisoPlacement, type LineaPlacement } from "./placement.ts";
import {
  chatExterno,
  etiquetaLinea,
  instanciasEnLinea,
  lineaDe,
  normalizarOpenlinesDoc,
  partirChatExterno,
  type OpenlinesBitrixDoc,
  type TokensOAuth,
} from "./tipos.ts";

/** Envío por el carril inmediato (sin cola); lo provee el gestor de sesiones. */
export type EnviarInmediato = (
  tenantId: TenantId,
  instanceId: InstanceId,
  telefono: string,
  cuerpo: string,
) => Promise<Message>;

export interface AltaOpenlines {
  clientId: string;
  clientSecret: string;
  /** Dominio del portal de Bitrix24 del cliente, p. ej. digsol.bitrix24.mx. */
  dominio: string;
}

export interface ConfirmacionesAsignacion {
  /** El número ya atiende otra línea abierta y el cliente acepta moverlo. */
  reasignacion?: boolean;
  /** La línea abierta ya tiene otros números y el cliente acepta compartirla. */
  compartida?: boolean;
}

/**
 * Asignar exige una confirmación explícita que no llegó. El handler la
 * traduce a 409 con el detalle para que la pantalla la pida.
 */
export class ErrorConfirmacion extends Error {
  constructor(
    readonly tipo: "reasignacion" | "compartida",
    readonly detalle: { lineaActual?: number; numeros?: string[] },
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "ErrorConfirmacion";
  }
}

/** Una línea de WhatsApp del tenant con su estado real y su línea abierta. */
export interface LineaResumen {
  instanceId: InstanceId;
  /** Nombre que le puso el cliente; null → se muestra el número. */
  nombre: string | null;
  numero: string | null;
  estado: Instance["estado"];
  viva: boolean;
  lineId: number | null;
  lineaNombre: string | null;
  asignadaEn: string | null;
}

/** Normaliza lo que el usuario pegue: URL completa, con barra, mayúsculas… → solo el host. */
export function normalizarDominioPortal(entrada: string): string {
  const s = entrada.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{2,}\.[a-z]{2,}$/.test(s)) {
    throw new Error("el dominio del portal no es válido; ejemplo: tuempresa.bitrix24.mx");
  }
  return s;
}

/** Tope de líneas abiertas por plan de Bitrix24 (helpdesk, FAQ Contact Center). Para explicar el error crudo. */
export const TOPE_LINEAS_ABIERTAS_BITRIX = "Free 1 · Basic 2 · Standard 10 · Professional y Enterprise sin tope";

const ICONO_SVG =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#25D366"/><path d="M12 28l2-5a9 9 0 1 1 3 3z" fill="#fff"/></svg>`,
  ).toString("base64");

const NOMBRE_CONECTOR = "WhatsApp · Digsol Factory";
/** Vigencia del token que autentica el POST de vuelta desde la página del placement. */
const TOKEN_PLACEMENT_MS = 30 * 60_000;

/**
 * Canal abierto de Bitrix24: conecta las líneas de WhatsApp de un tenant al
 * Contact Center de un portal. Aparte del conector Bitrix por webhook.
 *
 * Un conector por tenant, activado en N líneas abiertas: cada número atiende
 * exactamente una línea abierta; una línea abierta puede tener varios
 * números (compartida, con confirmación). El ruteo, la cola y el equipo son
 * propiedades de la línea abierta en Bitrix, no nuestras.
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
  readonly #sesionViva: (instanceId: InstanceId) => boolean;
  readonly #ahora: () => number;
  /** Nombres de líneas abiertas por tenant, 60 s: la tabla se abre seguido y Bitrix no es rápido. */
  readonly #nombresLineas = new Map<TenantId, { hasta: number; nombres: Map<number, string> }>();

  constructor(opciones: {
    repo: Repositorio;
    enviarInmediato: EnviarInmediato;
    /** Base pública del orquestador (p. ej. https://api.factory.digsol.com.mx). */
    urlPublica: string;
    /** ¿La sesión de esta instancia vive en el gestor? Sin gestor, siempre false. */
    sesionViva?: (instanceId: InstanceId) => boolean;
    cola?: ColaEnvios;
    cripto?: Cripto;
    fetchImpl?: typeof fetch;
    dormir?: (ms: number) => Promise<void>;
    ahora?: () => number;
  }) {
    this.#repo = opciones.repo;
    this.#cola = opciones.cola ?? null;
    this.#cripto = opciones.cripto ?? new Cripto();
    this.#enviar = opciones.enviarInmediato;
    this.#urlPublica = opciones.urlPublica.replace(/\/+$/, "");
    this.#fetch = opciones.fetchImpl;
    this.#dormir = opciones.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#sesionViva = opciones.sesionViva ?? (() => false);
    this.#ahora = opciones.ahora ?? (() => Date.now());
  }

  /** URL única del tenant para instalación, placement y eventos. */
  urlHandler(tenantId: TenantId): string {
    return `${this.#urlPublica}/bitrix/openlines/${tenantId}`;
  }

  connectorId(tenantId: TenantId): string {
    return `digsol_factory_${tenantId}`;
  }

  async #doc(tenantId: TenantId): Promise<OpenlinesBitrixDoc | null> {
    return normalizarOpenlinesDoc(await this.#repo.getOpenlinesBitrix(tenantId));
  }

  // ── Alta desde la plataforma ─────────────────────────────────────────────

  /** Guarda la app local (client_id/secret cifrados) y deja el conector pendiente de instalación. */
  async guardarAlta(tenantId: TenantId, alta: AltaOpenlines): Promise<OpenlinesBitrixDoc> {
    if (!alta.clientId.trim() || !alta.clientSecret.trim()) {
      throw new Error("se requieren client_id y client_secret de la aplicación local de Bitrix24");
    }
    const dominio = normalizarDominioPortal(alta.dominio);
    const previo = await this.#doc(tenantId);
    const ahora = new Date().toISOString();
    const doc: OpenlinesBitrixDoc = {
      connectorId: this.connectorId(tenantId),
      asignaciones: previo?.asignaciones ?? {},
      tokensCifrados: previo?.tokensCifrados ?? "",
      appCifrada: this.#cripto.cifrar(JSON.stringify({ clientId: alta.clientId.trim(), clientSecret: alta.clientSecret.trim() })),
      dominio,
      botId: previo?.botId ?? null,
      instaladoEn: previo?.instaladoEn ?? null,
      actualizadoEn: ahora,
    };
    await this.#repo.saveOpenlinesBitrix(tenantId, doc);
    registrar("openlines.alta", { tenant: tenantId, dominio, resultado: previo ? "editada" : "creada" });
    return doc;
  }

  async ver(tenantId: TenantId) {
    const doc = await this.#doc(tenantId);
    if (!doc) return null;
    return {
      connectorId: doc.connectorId,
      instalada: doc.tokensCifrados !== "",
      dominio: doc.dominio,
      botId: doc.botId,
      instaladoEn: doc.instaladoEn,
      actualizadoEn: doc.actualizadoEn,
      urlHandler: this.urlHandler(tenantId),
      asignaciones: Object.entries(doc.asignaciones).map(([instanceId, a]) => ({ instanceId, lineId: a.lineId, asignadaEn: a.asignadaEn })),
    };
  }

  async quitar(tenantId: TenantId): Promise<void> {
    await this.#repo.deleteOpenlinesBitrix(tenantId);
    registrar("openlines.baja", { tenant: tenantId });
  }

  // ── Credenciales y cliente ───────────────────────────────────────────────

  #credenciales(doc: OpenlinesBitrixDoc): CredencialesApp {
    return JSON.parse(this.#cripto.descifrar(doc.appCifrada)) as CredencialesApp;
  }

  #tokens(doc: OpenlinesBitrixDoc): TokensOAuth {
    if (!doc.tokensCifrados) throw new Error("la aplicación aún no se ha instalado en el portal");
    return JSON.parse(this.#cripto.descifrar(doc.tokensCifrados)) as TokensOAuth;
  }

  #cliente(tenantId: TenantId, doc: OpenlinesBitrixDoc, timeoutMs?: number): ClienteOpenlines {
    return new ClienteOpenlines({
      tokens: this.#tokens(doc),
      credenciales: this.#credenciales(doc),
      ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      alRenovar: async (t) => {
        const actual = (await this.#doc(tenantId)) ?? doc;
        await this.#repo.saveOpenlinesBitrix(tenantId, {
          ...actual,
          tokensCifrados: this.#cripto.cifrar(JSON.stringify(t)),
          actualizadoEn: new Date().toISOString(),
        });
        registrar("openlines.token_renovado", { tenant: tenantId, dominio: t.dominio });
      },
    });
  }

  /** Doc instalado o error claro. */
  async #instalado(tenantId: TenantId): Promise<{ doc: OpenlinesBitrixDoc; cliente: ClienteOpenlines }> {
    const doc = await this.#doc(tenantId);
    if (!doc) throw new Error("tenant sin canal abierto dado de alta");
    if (!doc.tokensCifrados) throw new Error("la aplicación aún no se ha instalado en el portal de Bitrix");
    return { doc, cliente: this.#cliente(tenantId, doc) };
  }

  // ── Instalación (ONAPPINSTALL) ───────────────────────────────────────────

  /**
   * Bitrix instaló la app en el portal y nos manda los tokens. Solo se
   * acepta si el tenant dio de alta la app antes; si ya había una
   * instalación, el portal (member_id) debe coincidir. Idempotente.
   */
  async instalar(tenantId: TenantId, auth: unknown): Promise<void> {
    const doc = await this.#doc(tenantId);
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
    // imconnector.register con el mismo ID actualiza el conector (documentado):
    // es idempotente por sí mismo. event.bind no lo es; suscribirMensajes lo resuelve.
    await cliente.registrarConector({
      id: instalado.connectorId,
      nombre: NOMBRE_CONECTOR,
      icono: { DATA_IMAGE: ICONO_SVG },
      placementHandler: handler,
    });
    const suscripcion = await cliente.suscribirMensajes(handler);
    registrar("openlines.instalada", {
      tenant: tenantId, dominio: tokens.dominio, conector: instalado.connectorId,
      reinstalacion: Boolean(doc.tokensCifrados), evento: suscripcion.resultado,
      ...(suscripcion.desenlazados.length ? { handlersViejosDesenlazados: suscripcion.desenlazados.length } : {}),
    });
  }

  /** ¿El evento viene del portal instalado? Compara application_token. */
  async eventoAutentico(tenantId: TenantId, auth: any): Promise<boolean> {
    const doc = await this.#doc(tenantId);
    if (!doc?.tokensCifrados) return false;
    const tokens = this.#tokens(doc);
    const recibido = auth?.application_token;
    return typeof recibido === "string" && recibido.length > 0 && recibido === tokens.applicationToken;
  }

  // ── Líneas: estado real, líneas abiertas del portal, asignaciones ────────

  /** Etiqueta legible de cada instancia (nombre y número, o número, o id), para Bitrix y para avisos. */
  async #numerosDe(tenantId: TenantId, instanceIds: string[]): Promise<string[]> {
    const etiquetas: string[] = [];
    for (const i of instanceIds) {
      const inst = await this.#repo.getInstance(tenantId, i);
      etiquetas.push(inst ? etiquetaLinea(inst) : i);
    }
    return etiquetas;
  }

  /**
   * Todas las líneas de WhatsApp del tenant con estado real (sesión viva +
   * estado del registro) y la línea abierta que atienden. Una sola lectura
   * de Firestore y consultas en memoria: siete líneas no cuestan más que
   * una. Los nombres de las líneas abiertas se piden a Bitrix solo si la
   * app está instalada, best-effort: si Bitrix no responde, la tabla sale
   * sin nombres y con `lineasAbiertasError`.
   */
  async lineas(tenantId: TenantId): Promise<{ lineas: LineaResumen[]; lineasAbiertasError: string | null }> {
    const [instancias, doc] = await Promise.all([this.#repo.listInstances(tenantId), this.#doc(tenantId)]);
    let nombres = new Map<number, string>();
    let lineasAbiertasError: string | null = null;
    if (doc?.tokensCifrados) {
      const cache = this.#nombresLineas.get(tenantId);
      if (cache && cache.hasta > this.#ahora()) {
        nombres = cache.nombres;
      } else {
        try {
          // Best-effort y con tiempo límite corto: la tabla no debe esperar a Bitrix.
          nombres = new Map((await this.#cliente(tenantId, doc, 5_000).listarLineasAbiertas()).map((l) => [l.id, l.nombre]));
          this.#nombresLineas.set(tenantId, { hasta: this.#ahora() + 60_000, nombres });
        } catch (err) {
          lineasAbiertasError = err instanceof Error ? err.message : String(err);
          registrarError("openlines.lineas_abiertas", err, { tenant: tenantId });
        }
      }
    }
    const lineas = instancias.map((i): LineaResumen => {
      const a = doc?.asignaciones[i.id] ?? null;
      return {
        instanceId: i.id,
        nombre: i.nombre ?? null,
        numero: i.numero,
        estado: i.estado,
        viva: this.#sesionViva(i.id),
        lineId: a?.lineId ?? null,
        lineaNombre: a ? nombres.get(a.lineId) ?? null : null,
        asignadaEn: a?.asignadaEn ?? null,
      };
    });
    return { lineas, lineasAbiertasError };
  }

  /** Líneas abiertas existentes en el portal, con los números que ya las atienden. */
  async lineasAbiertas(tenantId: TenantId): Promise<{ id: number; nombre: string; activa: boolean; numeros: { instanceId: string; numero: string | null }[] }[]> {
    const { doc, cliente } = await this.#instalado(tenantId);
    const lista = await cliente.listarLineasAbiertas();
    const instancias = await this.#repo.listInstances(tenantId);
    const numeroDe = new Map(instancias.map((i) => [i.id, i.numero]));
    return lista.map((l) => ({
      ...l,
      numeros: instanciasEnLinea(doc, l.id).map((instanceId) => ({ instanceId, numero: numeroDe.get(instanceId) ?? null })),
    }));
  }

  /**
   * Crea una línea abierta en el portal. NUNCA por default: la pantalla
   * ofrece primero las existentes y "crear" es una acción explícita. Nace
   * activa, con el usuario de la app como único operador; el equipo y el
   * horario se afinan en Bitrix (enlace al Contact Center).
   */
  async crearLineaAbierta(tenantId: TenantId, nombre: string): Promise<{ id: number; nombre: string; urlContactCenter: string | null }> {
    const limpio = nombre.trim();
    if (!limpio) throw new Error("la línea abierta necesita un nombre");
    const { cliente } = await this.#instalado(tenantId);
    const operadorId = await cliente.usuarioActual();
    try {
      const id = await cliente.crearLineaAbierta({ nombre: limpio, operadorId });
      registrar("openlines.linea_creada", { tenant: tenantId, linea: id, nombre: limpio, operador: operadorId });
      return { id, nombre: limpio, urlContactCenter: await cliente.urlContactCenter() };
    } catch (err) {
      registrarError("openlines.linea_creada", err, { tenant: tenantId, nombre: limpio });
      const crudo = err instanceof ErrorBitrix ? (err.descripcion ?? err.codigo ?? err.message) : err instanceof Error ? err.message : String(err);
      throw new Error(
        `Bitrix no permitió crear la línea abierta: ${crudo}. ` +
        `Cada plan de Bitrix24 tiene un tope de líneas abiertas (${TOPE_LINEAS_ABIERTAS_BITRIX}). ` +
        `Si estás en el tope, sube de plan en Bitrix o comparte una línea abierta existente entre varios números.`,
      );
    }
  }

  /**
   * El número `instanceId` pasa a atender la línea abierta `lineId`.
   * - Si ya atendía otra, exige `confirmaciones.reasignacion` y deja de
   *   atender la anterior (que se desactiva si queda vacía).
   * - Si la línea ya tiene otros números, exige `confirmaciones.compartida`.
   * Sin la confirmación que toque lanza ErrorConfirmacion; nada cambia.
   */
  async asignar(tenantId: TenantId, instanceId: InstanceId, lineId: number, confirmaciones: ConfirmacionesAsignacion = {}): Promise<OpenlinesBitrixDoc> {
    if (!Number.isInteger(lineId) || lineId <= 0) throw new Error("línea abierta inválida");
    const { doc, cliente } = await this.#instalado(tenantId);
    const instancia = await this.#repo.getInstance(tenantId, instanceId);
    if (!instancia) throw new Error("línea de WhatsApp no encontrada en este tenant");

    const lineaActual = lineaDe(doc, instanceId);
    if (lineaActual !== null && lineaActual !== lineId && !confirmaciones.reasignacion) {
      throw new ErrorConfirmacion("reasignacion", { lineaActual }, `este número ya atiende la línea abierta ${lineaActual}; confirma para moverlo`);
    }
    const otros = instanciasEnLinea(doc, lineId).filter((i) => i !== instanceId);
    if (otros.length && !confirmaciones.compartida) {
      const numeros = await this.#numerosDe(tenantId, otros);
      throw new ErrorConfirmacion("compartida", { numeros }, `esta línea abierta ya la atienden ${numeros.join(" y ")}; confirma para compartirla`);
    }

    // Bitrix: activar el conector en la línea y describir el canal con TODOS sus números.
    const todosEnLinea = [...otros, instanceId].sort();
    await cliente.activarConector({ connector: doc.connectorId, line: lineId, active: true });
    await cliente.fijarDatosConector({
      connector: doc.connectorId,
      line: lineId,
      id: todosEnLinea.join(","),
      nombre: `${NOMBRE_CONECTOR} · ${(await this.#numerosDe(tenantId, todosEnLinea)).join(", ")}`,
    });

    const ahora = new Date().toISOString();
    const actualizado: OpenlinesBitrixDoc = {
      ...doc,
      asignaciones: { ...doc.asignaciones, [instanceId]: { lineId, asignadaEn: lineaActual === lineId ? doc.asignaciones[instanceId]?.asignadaEn ?? ahora : ahora } },
      actualizadoEn: ahora,
    };

    // La línea anterior: sin números se desactiva; con otros, se re-describe.
    if (lineaActual !== null && lineaActual !== lineId) {
      const restantes = instanciasEnLinea(actualizado, lineaActual);
      try {
        if (restantes.length === 0) {
          await cliente.activarConector({ connector: doc.connectorId, line: lineaActual, active: false });
        } else {
          await cliente.fijarDatosConector({
            connector: doc.connectorId, line: lineaActual, id: restantes.join(","),
            nombre: `${NOMBRE_CONECTOR} · ${(await this.#numerosDe(tenantId, restantes)).join(", ")}`,
          });
        }
      } catch (err) {
        // La asignación nueva ya está hecha en Bitrix; la limpieza de la vieja no la deshace.
        registrarError("openlines.asignacion", err, { tenant: tenantId, instancia: instanceId, lineaAnterior: lineaActual, paso: "limpiar línea anterior" });
      }
    }

    await this.#repo.saveOpenlinesBitrix(tenantId, actualizado);
    registrar("openlines.asignacion", {
      tenant: tenantId, instancia: instanceId, nombre: instancia.nombre ?? null, numero: enmascararTelefono(instancia.numero), linea: lineId,
      resultado: lineaActual === null ? "asignada" : lineaActual === lineId ? "sin cambio" : "reasignada",
      ...(lineaActual !== null && lineaActual !== lineId ? { lineaAnterior: lineaActual } : {}),
      ...(otros.length ? { compartidaCon: otros.length } : {}),
    });
    return actualizado;
  }

  /** El número deja de atender su línea abierta; si la línea queda vacía, se desactiva. */
  async desasignar(tenantId: TenantId, instanceId: InstanceId): Promise<OpenlinesBitrixDoc> {
    const { doc, cliente } = await this.#instalado(tenantId);
    const lineaActual = lineaDe(doc, instanceId);
    if (lineaActual === null) return doc;
    const { [instanceId]: _quitada, ...resto } = doc.asignaciones;
    const actualizado: OpenlinesBitrixDoc = { ...doc, asignaciones: resto, actualizadoEn: new Date().toISOString() };
    const restantes = instanciasEnLinea(actualizado, lineaActual);
    if (restantes.length === 0) {
      await cliente.activarConector({ connector: doc.connectorId, line: lineaActual, active: false });
    } else {
      await cliente.fijarDatosConector({
        connector: doc.connectorId, line: lineaActual, id: restantes.join(","),
        nombre: `${NOMBRE_CONECTOR} · ${(await this.#numerosDe(tenantId, restantes)).join(", ")}`,
      });
    }
    await this.#repo.saveOpenlinesBitrix(tenantId, actualizado);
    registrar("openlines.asignacion", { tenant: tenantId, instancia: instanceId, linea: lineaActual, resultado: "quitada", ...(restantes.length ? { quedanEnLinea: restantes.length } : {}) });
    return actualizado;
  }

  // ── Placement (página dentro de Bitrix) ──────────────────────────────────

  #tokenPlacement(tenantId: TenantId, line: number, memberId: string): string {
    return this.#cripto.cifrar(JSON.stringify({ t: tenantId, l: line, m: memberId, exp: this.#ahora() + TOKEN_PLACEMENT_MS }));
  }

  #abrirTokenPlacement(tenantId: TenantId, token: string): { line: number; memberId: string } | null {
    try {
      const d = JSON.parse(this.#cripto.descifrar(token)) as { t?: string; l?: number; m?: string; exp?: number };
      if (d.t !== tenantId || typeof d.l !== "number" || typeof d.m !== "string" || typeof d.exp !== "number") return null;
      if (d.exp < this.#ahora()) return null;
      return { line: d.l, memberId: d.m };
    } catch {
      return null;
    }
  }

  async #modeloPlacement(tenantId: TenantId, doc: OpenlinesBitrixDoc, line: number, memberId: string, seleccion: string | null, aviso: AvisoPlacement | null): Promise<string> {
    const { lineas } = await this.lineas(tenantId);
    const cliente = this.#cliente(tenantId, doc);
    let lineaNombre: string | null = null;
    try { lineaNombre = (await cliente.listarLineasAbiertas()).find((l) => l.id === line)?.nombre ?? null; } catch { /* sin nombre */ }
    const enEsta = lineas.find((l) => l.lineId === line);
    return htmlPlacement({
      line,
      lineaNombre,
      connectorId: doc.connectorId,
      token: this.#tokenPlacement(tenantId, line, memberId),
      lineas: lineas.map((l): LineaPlacement => ({ instanceId: l.instanceId, nombre: l.nombre, numero: l.numero, estado: l.estado, viva: l.viva, lineId: l.lineId })),
      seleccion: seleccion ?? enEsta?.instanceId ?? null,
      aviso,
      urlContactCenter: await cliente.urlContactCenter(),
    });
  }

  /**
   * SETTING_CONNECTOR: Bitrix abre nuestra página para la línea LINE.
   * Solo desde el portal instalado (member_id); si no, se rechaza y se
   * registra: un POST desde fuera podría redirigir la línea de un cliente.
   */
  async paginaPlacement(tenantId: TenantId, opciones: { line: number; memberId: string | null }): Promise<{ status: number; html: string }> {
    const doc = await this.#doc(tenantId);
    if (!doc?.tokensCifrados) return { status: 404, html: htmlRechazo("Este tenant no tiene la aplicación instalada. Da de alta el canal abierto en la plataforma de Digsol Factory e instala la app desde tu portal.") };
    const tokens = this.#tokens(doc);
    if (!opciones.memberId || opciones.memberId !== tokens.memberId) {
      registrar("openlines.placement_rechazado", { tenant: tenantId, linea: opciones.line, motivo: opciones.memberId ? "member_id distinto" : "sin member_id" }, "warn");
      return { status: 403, html: htmlRechazo("Esta página solo se abre desde el portal de Bitrix24 donde está instalada la aplicación.") };
    }
    registrar("openlines.placement", { tenant: tenantId, linea: opciones.line });
    return { status: 200, html: await this.#modeloPlacement(tenantId, doc, opciones.line, opciones.memberId, null, null) };
  }

  /** POST de vuelta desde la página: el cliente eligió un número (y, si tocaba, confirmó). */
  async asignarDesdePlacement(tenantId: TenantId, datos: { token: string; instanceId: string; confirmarReasignacion: boolean; confirmarCompartida: boolean }): Promise<{ status: number; html: string }> {
    const doc = await this.#doc(tenantId);
    if (!doc?.tokensCifrados) return { status: 404, html: htmlRechazo("Este tenant no tiene la aplicación instalada.") };
    const abierto = this.#abrirTokenPlacement(tenantId, datos.token);
    if (!abierto || abierto.memberId !== this.#tokens(doc).memberId) {
      registrar("openlines.placement_rechazado", { tenant: tenantId, motivo: "token inválido o vencido" }, "warn");
      return { status: 403, html: htmlRechazo("La sesión de esta página venció. Cierra el panel y vuelve a abrir el conector desde Contact Center.") };
    }
    const { line, memberId } = abierto;
    if (!datos.instanceId) {
      return { status: 400, html: await this.#modeloPlacement(tenantId, doc, line, memberId, null, { tipo: "error", mensaje: "Elige un número de WhatsApp." }) };
    }
    try {
      const actualizado = await this.asignar(tenantId, datos.instanceId, line, { reasignacion: datos.confirmarReasignacion, compartida: datos.confirmarCompartida });
      const inst = await this.#repo.getInstance(tenantId, datos.instanceId);
      return { status: 200, html: await this.#modeloPlacement(tenantId, actualizado, line, memberId, datos.instanceId, { tipo: "ok", instanceId: datos.instanceId, numero: inst?.numero ?? null, nombre: inst?.nombre ?? null }) };
    } catch (err) {
      if (err instanceof ErrorConfirmacion) {
        const aviso: AvisoPlacement = err.tipo === "reasignacion"
          ? { tipo: "reasignacion", lineaActual: err.detalle.lineaActual ?? 0 }
          : { tipo: "compartida", numeros: err.detalle.numeros ?? [] };
        return { status: 200, html: await this.#modeloPlacement(tenantId, doc, line, memberId, datos.instanceId, aviso) };
      }
      registrarError("openlines.asignacion", err, { tenant: tenantId, instancia: datos.instanceId, linea: line, origen: "placement" });
      return { status: 200, html: await this.#modeloPlacement(tenantId, doc, line, memberId, datos.instanceId, { tipo: "error", mensaje: err instanceof Error ? err.message : String(err) }) };
    }
  }

  // ── imbot ────────────────────────────────────────────────────────────────

  /**
   * Registra el imbot de línea abierta y guarda su id. Es la pieza de la
   * prueba de visibilidad: con bot registrado, las respuestas de los bots
   * se reflejan en el chat del operador y sus eventos se reconocen para
   * no rebotar al contacto. Si la prueba falla, se quita y se cae a C.
   */
  async registrarBot(tenantId: TenantId): Promise<number> {
    const { doc, cliente } = await this.#instalado(tenantId);
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
   * Manda a la línea abierta que atiende el número un mensaje que llegó.
   * Devuelve false si no aplica. Nunca lanza hacia el webhook: el fallo
   * queda en la bitácora.
   */
  async entrante(tenantId: TenantId, instanceId: InstanceId, mensaje: Message, nombre?: string | null): Promise<boolean> {
    const doc = await this.#doc(tenantId);
    // Sin alta, el tenant no usa canal abierto: silencio. Con alta, cada
    // omisión deja línea: "nada" tiene que distinguirse de "no se intentó".
    if (!doc) return false;
    const omitir = (motivo: string, nivel: "info" | "warn" = "warn"): false => {
      registrar("openlines.entrante", {
        tenant: tenantId, instancia: instanceId, mensaje: mensaje.id, telefono: enmascararTelefono(mensaje.telefono),
        resultado: "omitido", motivo,
      }, nivel);
      return false;
    };
    if (!doc.tokensCifrados) return omitir("app no instalada en el portal");
    const lineId = lineaDe(doc, instanceId);
    if (lineId === null) return omitir("número sin línea abierta asignada");
    const telefono = mensaje.telefono.replace(/[^\d]/g, "");
    const chatId = chatExterno(instanceId, telefono);
    const nombreLinea = (await this.#repo.getInstance(tenantId, instanceId))?.nombre ?? null;
    try {
      const cliente = this.#cliente(tenantId, doc);
      const r = await cliente.enviarEntrante({
        connector: doc.connectorId,
        line: lineId,
        chatId,
        usuario: { id: telefono, nombre: nombre ?? null, telefono: `+${telefono}` },
        mensaje: { id: mensaje.id, fecha: new Date(mensaje.timestamp), texto: mensaje.cuerpo },
      });
      await this.#repo.vincularOpenLine(tenantId, instanceId, telefono, {
        lineId,
        chatId: r.chatId,
        sessionId: r.sessionId,
        actualizadoEn: new Date().toISOString(),
      });
      registrar("openlines.entrante", {
        tenant: tenantId, instancia: instanceId, nombre: nombreLinea, mensaje: mensaje.id, telefono: enmascararTelefono(mensaje.telefono),
        linea: lineId, chatBitrix: r.chatId, sesionBitrix: r.sessionId, resultado: "ok",
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
    const doc = await this.#doc(tenantId);
    if (!doc?.tokensCifrados || doc.botId === null || lineaDe(doc, instanceId) === null) return;
    const conv = await this.#repo.getConversacion(tenantId, instanceId, telefono.replace(/[^\d]/g, ""));
    const imChatId = conv?.bitrixOpenLine?.chatId ? Number(conv.bitrixOpenLine.chatId) : null;
    if (!imChatId) return;
    // Primero el método de chatbots de Open Channels; si Bitrix lo rechaza,
    // el genérico de imbot. La bitácora dice cuál entró: es la prueba de
    // visibilidad, y decide A o C sin otro despliegue.
    const cliente = this.#cliente(tenantId, doc);
    const base = { tenant: tenantId, instancia: instanceId, chatBitrix: imChatId, botId: doc.botId };
    try {
      await cliente.mensajeDeBotEnSesion({ imChatId, texto: `🤖 ${texto}` });
      registrar("openlines.bot_reflejado", { ...base, metodo: "imopenlines.bot.session.message.send" });
      return;
    } catch (err1) {
      try {
        await cliente.mensajeDeBot({ botId: doc.botId, imChatId, texto: `🤖 ${texto}` });
        registrar("openlines.bot_reflejado", { ...base, metodo: "imbot.message.add", nota: `session.message.send falló: ${err1 instanceof Error ? err1.message : String(err1)}` });
      } catch (err2) {
        registrarError("openlines.bot_reflejado", err2, { ...base, errorSesion: err1 instanceof Error ? err1.message : String(err1) });
      }
    }
  }

  // ── Saliente: operador → WhatsApp ────────────────────────────────────────

  /**
   * OnImConnectorMessageAdd: el operador escribió. El chat externo dice por
   * qué número sale (instancia:teléfono). Va por el carril inmediato con
   * espaciado por conversación y tope de ráfaga por número (el excedente a
   * la cola normal, registrado). Confirma la entrega a Bitrix y abre/renueva
   * la ventana humana. Los mensajes del propio imbot se ignoran para que no
   * reboten al contacto.
   */
  async respuestaOperador(tenantId: TenantId, data: unknown): Promise<void> {
    const doc = await this.#doc(tenantId);
    if (!doc?.tokensCifrados || Object.keys(doc.asignaciones).length === 0) {
      registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "canal sin números asignados" }, "warn");
      return;
    }
    const { connector, line, mensajes } = interpretarEventoMensajes(data);
    if (connector !== doc.connectorId || line === null) {
      registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "conector distinto o sin línea", conector: connector, linea: line }, "warn");
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
      if (!partes) {
        registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "chat externo no reconocido", chat: m.chatExternoId }, "warn");
        continue;
      }
      const { instanceId, telefono } = partes;
      const lineaAsignada = lineaDe(doc, instanceId);
      if (lineaAsignada === null) {
        registrar("openlines.operador", { tenant: tenantId, resultado: "ignorado", motivo: "número sin línea abierta asignada", instancia: instanceId, linea: line }, "warn");
        continue;
      }
      const nombreLinea = (await this.#repo.getInstance(tenantId, instanceId))?.nombre ?? null;
      const base = { tenant: tenantId, instancia: instanceId, nombre: nombreLinea, telefono: enmascararTelefono(telefono), imMensaje: m.imMessageId, usuario: m.userId, linea: line };
      if (lineaAsignada !== line) {
        // El chat vive en la línea donde se abrió; el número ya atiende otra. Se entrega igual: el contacto sigue en ese número.
        registrar("openlines.operador", { ...base, nota: `número reasignado a la línea ${lineaAsignada}; se entrega por el chat original` });
      }

      if (!m.texto.trim() || m.archivos.length) {
        // EXPERIMENTO multimedia: la entrada cruda (sin tokens; el auth no viene en data) para ver cómo llegan imagen y nota de voz.
        registrar("openlines.adjunto_crudo", { ...base, crudo: resumirCrudo(m.crudo) });
      }
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
            connector: doc.connectorId, line, imChatId: m.imChatId, imMessageId: m.imMessageId,
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
