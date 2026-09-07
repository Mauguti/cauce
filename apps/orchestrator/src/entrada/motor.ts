import type { InstanceId, Message, TenantId } from "@cauce/core";
import type { Repositorio } from "../store.ts";
import type { ConectorMonday } from "../monday/conector.ts";
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

  constructor(opciones: {
    repo: Repositorio;
    enviarInmediato: EnviarInmediato;
    monday?: ConectorMonday;
  }) {
    this.#repo = opciones.repo;
    this.#enviar = opciones.enviarInmediato;
    this.#monday = opciones.monday ?? null;
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

    // 2. Disparadores: primera coincidencia por prioridad gana; respuesta
    //    por el carril inmediato (sin rate limiting).
    const disparadores = await this.#repo.getDisparadores(tenantId);
    const disparador = primeroQueCoincide(disparadores, {
      texto: mensaje.cuerpo,
      esPrimerContacto,
      ahora: new Date(mensaje.timestamp),
    });
    if (disparador) {
      await this.#enviar(tenantId, instanceId, mensaje.telefono, disparador.respuesta);
    }

    // 3. Write-back al CRM: si la conversación está vinculada a un item de
    //    monday, la respuesta del cliente vuelve como update.
    if (this.#monday && conversacion.mondayItemId) {
      await this.#monday.publicarEnItem(
        tenantId,
        conversacion.mondayItemId,
        `📥 ${mensaje.cuerpo}`,
      );
    }
  }
}
