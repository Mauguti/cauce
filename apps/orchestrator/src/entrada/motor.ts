import type { InstanceId, Message, TenantId } from "@cauce/core";
import { tieneCapacidad, type Capacidad } from "@cauce/core";
import { registrar, registrarCadaMs } from "../log.ts";
import type { ConectorOpenlines } from "../bitrix/openlines/conector.ts";
import type { Repositorio } from "../store.ts";
import type { ConectorMonday } from "../monday/conector.ts";
import type { ConectorBitrix } from "../bitrix/conector.ts";
import type { EntidadBitrix } from "../bitrix/cliente.ts";
import { primeroQueCoincide } from "./disparadores.ts";

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

  constructor(opciones: {
    repo: Repositorio;
    enviarInmediato: EnviarInmediato;
    monday?: ConectorMonday;
    bitrix?: ConectorBitrix;
    openlines?: ConectorOpenlines;
  }) {
    this.#repo = opciones.repo;
    this.#enviar = opciones.enviarInmediato;
    this.#monday = opciones.monday ?? null;
    this.#bitrix = opciones.bitrix ?? null;
    this.#openlines = opciones.openlines ?? null;
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
    //    por el carril inmediato (sin rate limiting).
    if (puede("bots") && !humana) {
      const disparadores = await this.#repo.getDisparadores(tenantId);
      const disparador = primeroQueCoincide(disparadores, {
        texto: mensaje.cuerpo,
        esPrimerContacto,
        ahora: new Date(mensaje.timestamp),
      });
      if (disparador) {
        await this.#enviar(tenantId, instanceId, mensaje.telefono, disparador.respuesta);
        // Espejo en el Contact Center para que el operador vea qué respondió el bot.
        if (this.#openlines) {
          await this.#openlines.reflejarBot(tenantId, instanceId, mensaje.telefono, disparador.respuesta).catch(() => {});
        }
      }
    } else if (tenant) {
      registrarCadaMs(`bots-pausados:${tenantId}`, 10 * 60_000, "bots.pausados", {
        tenant: tenantId, plan: tenant.plan, motivo: "el plan no incluye bots o la cuenta está en solo lectura",
      }, "warn");
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
