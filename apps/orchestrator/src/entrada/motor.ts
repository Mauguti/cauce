import type { InstanceId, Message, TenantId } from "@cauce/core";
import { tieneCapacidad, type Capacidad } from "@cauce/core";
import { enmascararTelefono, registrar, registrarCadaMs } from "../log.ts";
import type { ConectorOpenlines } from "../bitrix/openlines/conector.ts";
import type { Repositorio } from "../store.ts";
import type { ConectorMonday } from "../monday/conector.ts";
import type { ConectorBitrix } from "../bitrix/conector.ts";
import type { EntidadBitrix } from "../bitrix/cliente.ts";
import { primeroQueCoincide } from "./disparadores.ts";
import type { Agente } from "../agentes/agente.ts";

/**
 * Cortacircuitos de respuestas automáticas por conversación. Un bucle entre
 * dos agentes (dos líneas nuestras que se escriben) o contra un contestador
 * ajeno gasta tokens toda la noche; esto lo apaga solo.
 * - MAX respuestas automáticas en VENTANA_MIN minutos sin que un humano
 *   conteste → pausa PAUSA_HORAS.
 * - REPETICIONES respuestas automáticas idénticas seguidas → pausa (un bucle
 *   suele repetirse antes de llegar al tope).
 * Un operador que contesta (ventana humana) levanta la pausa.
 */
export const CORTACIRCUITOS = { max: 12, ventanaMin: 10, repeticiones: 3, pausaHoras: 6 };

/** Envía por el carril inmediato (sin cola). Lo provee GestorSesiones. */
export type EnviarInmediato = (
  tenantId: TenantId,
  instanceId: InstanceId,
  telefono: string,
  cuerpo: string,
) => Promise<unknown>;

/**
 * Procesa cada mensaje entrante: actualiza la conversación, dispara la
 * respuesta automática que corresponda (por el carril inmediato) y
 * devuelve la conversación al CRM. Es best-effort: se invoca sin bloquear
 * la respuesta 200 al webhook.
 */
export class MotorEntrada {
  readonly #repo: Repositorio;
  readonly #enviar: EnviarInmediato;
  readonly #monday: ConectorMonday | null;
  readonly #bitrix: ConectorBitrix | null;
  readonly #openlines: ConectorOpenlines | null;
  readonly #agente: Agente | null;
  readonly #avisosWhatsApp: string | null;
  readonly #ahora: () => number;

  constructor(opciones: {
    repo: Repositorio;
    enviarInmediato: EnviarInmediato;
    monday?: ConectorMonday;
    bitrix?: ConectorBitrix;
    openlines?: ConectorOpenlines;
    /** Agente conversacional (Santiago); contesta cuando ningún disparador lo hizo y el plan incluye agentes. */
    agente?: Agente;
    /** Número (E.164) al que se avisa por WhatsApp cuando salta el cortacircuitos; sin él, solo bitácora. */
    avisosWhatsApp?: string;
    ahora?: () => number;
  }) {
    this.#repo = opciones.repo;
    this.#enviar = opciones.enviarInmediato;
    this.#monday = opciones.monday ?? null;
    this.#bitrix = opciones.bitrix ?? null;
    this.#openlines = opciones.openlines ?? null;
    this.#agente = opciones.agente ?? null;
    this.#avisosWhatsApp = opciones.avisosWhatsApp?.trim() || null;
    this.#ahora = opciones.ahora ?? (() => Date.now());
  }

  /** ¿El remitente es una línea conectada nuestra? Del mismo tenant o de cualquiera. */
  async #lineaPropia(tenantId: TenantId, telefono: string): Promise<{ alcance: "mismo tenant" | "otro tenant"; tenantId: TenantId; instanceId: InstanceId } | null> {
    const propia = await this.#repo.buscarInstanciaPorNumero(telefono);
    if (!propia) return null;
    return { alcance: propia.tenantId === tenantId ? "mismo tenant" : "otro tenant", ...propia };
  }

  /**
   * Tras enviar una respuesta automática: la anota y, si la conversación
   * ya excede el tope en la ventana o repite el mismo texto, la apaga,
   * lo registra y avisa.
   */
  async #cortacircuitos(tenantId: TenantId, instanceId: InstanceId, telefono: string, texto: string, base: Record<string, unknown>): Promise<void> {
    const ahora = this.#ahora();
    const previa = await this.#repo.getConversacion(tenantId, instanceId, telefono);
    const repetido = previa?.ultimaAutoRespuesta === texto;
    const conv = await this.#repo.registrarRespuestaAutomatica(tenantId, instanceId, telefono, new Date(ahora).toISOString(), texto, CORTACIRCUITOS.max + 1);
    const desde = ahora - CORTACIRCUITOS.ventanaMin * 60_000;
    const enVentana = (conv.autoRespuestas ?? []).filter((t) => new Date(t).getTime() >= desde).length;
    // Ráfaga idéntica: el texto repite al anterior y ya van REPETICIONES
    // respuestas automáticas en los últimos 3 min. Un bucle se repite antes
    // de llegar al tope de la ventana; esto lo corta antes.
    const ultimas = (conv.autoRespuestas ?? []).slice(-CORTACIRCUITOS.repeticiones);
    const rafagaIdentica = repetido && ultimas.length >= CORTACIRCUITOS.repeticiones && ahora - new Date(ultimas[0]!).getTime() < 3 * 60_000;
    let motivo: string | null = null;
    if (enVentana > CORTACIRCUITOS.max) motivo = `${enVentana} respuestas automáticas en ${CORTACIRCUITOS.ventanaMin} min sin intervención humana`;
    else if (rafagaIdentica) motivo = `${CORTACIRCUITOS.repeticiones} respuestas automáticas idénticas seguidas`;
    if (!motivo) return;
    const hasta = new Date(ahora + CORTACIRCUITOS.pausaHoras * 3_600_000).toISOString();
    await this.#repo.pausarAutomatico(tenantId, instanceId, telefono, { hasta, motivo, conteo: enVentana });
    registrar("cortacircuitos.disparado", { ...base, motivo, conteo: enVentana, pausadaHasta: hasta }, "error");
    if (this.#avisosWhatsApp) {
      try {
        await this.#enviar(tenantId, instanceId, this.#avisosWhatsApp, `⛔ Digsol Factory · cortacircuitos\nTenant ${tenantId}, línea ${instanceId}, contacto ${enmascararTelefono(`+${telefono}`)}.\n${motivo}. Respuestas automáticas apagadas hasta ${hasta}; un operador que conteste las reactiva.`);
      } catch (err) {
        registrar("cortacircuitos.aviso_fallido", { ...base, error: err instanceof Error ? err.message : String(err) }, "warn");
      }
    }
  }

  async procesar(
    tenantId: TenantId,
    instanceId: InstanceId,
    mensaje: Message,
    nombre?: string | null,
  ): Promise<void> {
    const telefono = mensaje.telefono.replace(/[^\d]/g, "");

    // 1. Conversación: registro atómico; decide primer contacto sin carrera.
    //    Guarda el nombre del contacto (pushName) para dar contexto al
    //    registro en vez del número crudo.
    const { conversacion, esPrimerContacto } = await this.#repo.registrarEntrante(
      tenantId,
      instanceId,
      telefono,
      mensaje.timestamp,
      nombre,
    );

    // Capacidades del plan AHORA: los bots y el write-back se pausan si el
    // plan no los incluye o la prueba venció. La configuración se conserva.
    const tenant = await this.#repo.getTenant(tenantId);
    const puede = (c: Capacidad) => (tenant ? tieneCapacidad(tenant, c) : false);

    // Ventana humana (canal abierto): si un operador tiene el hilo, los
    // bots se pausan SOLO en esta conversación. La configuración no se toca.
    const humana = Boolean(conversacion.humanaHasta && new Date(conversacion.humanaHasta) > new Date());
    if (humana) {
      registrar("bots.pausados_por_operador", { tenant: tenantId, instancia: instanceId, hasta: conversacion.humanaHasta });
    }

    // 2. Disparadores: primera coincidencia por prioridad gana; respuesta
    //    por el carril inmediato (sin rate limiting). Si ninguno coincide y
    //    el plan incluye agentes, contesta el agente. Ambos respetan la
    //    ventana humana.
    // Una línea por entrante con qué pasó: "ninguno coincidió", "no hay
    // disparadores", "el plan no los incluye" y "ventana humana" no pueden
    // verse igual (silencio). Mismo criterio que openlines.entrante omitido.
    const base = { tenant: tenantId, instancia: instanceId, mensaje: mensaje.id, telefono: enmascararTelefono(mensaje.telefono) };
    // Anti-bucle 1: si el remitente es una línea conectada nuestra (de este
    // tenant o de cualquiera), NO hay respuesta automática. El mensaje ya
    // se guardó y se espeja al CRM: es tráfico real que el operador ve.
    const propia = await this.#lineaPropia(tenantId, telefono);
    // Anti-bucle 2: cortacircuitos activo en esta conversación.
    const pausada = Boolean(conversacion.autoPausadaHasta && new Date(conversacion.autoPausadaHasta).getTime() > this.#ahora());
    if (propia) {
      registrar("entrada.respuesta", { ...base, resultado: "ninguna", origen: `remitente es línea propia (${propia.alcance}: ${propia.instanceId})` }, "warn");
    } else if (pausada) {
      registrar("entrada.respuesta", { ...base, resultado: "ninguna", origen: `cortacircuitos activo hasta ${conversacion.autoPausadaHasta}: ${conversacion.cortacircuitos?.motivo ?? ""}` }, "warn");
    } else if (!humana && (puede("bots") || puede("agentes"))) {
      let respuesta: string | null = null;
      let origen = "";
      if (puede("bots")) {
        const disparadores = await this.#repo.getDisparadores(tenantId);
        const disparador = primeroQueCoincide(disparadores, {
          texto: mensaje.cuerpo,
          esPrimerContacto,
          ahora: new Date(mensaje.timestamp),
        });
        respuesta = disparador?.respuesta ?? null;
        origen = disparador ? `disparador:${disparador.id}` : disparadores.length === 0 ? "sin disparadores configurados" : `ninguno de ${disparadores.length} coincidió`;
      } else {
        origen = "plan sin bots";
      }
      if (respuesta === null && puede("agentes")) {
        if (this.#agente) {
          respuesta = await this.#agente.responder(tenantId, instanceId, mensaje, conversacion.nombre ?? nombre ?? null);
          origen += respuesta ? "; agente respondió" : "; agente sin respuesta";
        } else {
          origen += "; agente no disponible en este orquestador";
        }
      }
      registrar("entrada.respuesta", { ...base, esPrimerContacto, resultado: respuesta ? "enviada" : "ninguna", origen }, respuesta ? "info" : "warn");
      if (respuesta) {
        await this.#enviar(tenantId, instanceId, mensaje.telefono, respuesta);
        // Espejo en el Contact Center para que el operador vea qué respondió el bot o el agente.
        if (this.#openlines) {
          await this.#openlines.reflejarBot(tenantId, instanceId, mensaje.telefono, respuesta).catch(() => {});
        }
        await this.#cortacircuitos(tenantId, instanceId, telefono, respuesta, base);
      }
    } else if (tenant && !humana) {
      registrar("entrada.respuesta", { ...base, resultado: "ninguna", origen: `el plan ${tenant.plan} no incluye bots ni agentes, o la cuenta está en solo lectura` }, "warn");
      registrarCadaMs(`bots-pausados:${tenantId}`, 10 * 60_000, "bots.pausados", {
        tenant: tenantId, plan: tenant.plan, motivo: "el plan no incluye bots o la cuenta está en solo lectura",
      }, "warn");
    } else if (humana) {
      registrar("entrada.respuesta", { ...base, resultado: "ninguna", origen: `ventana humana hasta ${conversacion.humanaHasta}` });
    }

    // 3. Write-back al CRM: la respuesta del cliente vuelve al registro que
    //    la originó (item de monday o timeline de la entidad de Bitrix).
    if (!puede("entrantes")) return;
    const texto = `📥 ${mensaje.cuerpo}`;
    if (this.#monday && conversacion.mondayItemId) {
      await this.#monday.publicarEnItem(tenantId, conversacion.mondayItemId, texto);
    }
    if (this.#bitrix && conversacion.bitrixEntidad) {
      await this.#bitrix.publicarEnItem(
        tenantId,
        conversacion.bitrixEntidad.tipo as EntidadBitrix,
        conversacion.bitrixEntidad.id,
        texto,
      );
    }
  }
}
