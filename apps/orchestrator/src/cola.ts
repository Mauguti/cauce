import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { InstanceId, Message } from "@cauce/core";
import type { MessageTransport } from "@cauce/transports";
import type { Repositorio } from "./store.ts";

/**
 * Cola de envío por instancia, persistida en disco: un reinicio del
 * orquestador no pierde mensajes encolados (se recargan al registrar la
 * instancia en la rehidratación). Un mensaje que estaba `enviando` en
 * el momento del crash vuelve a `encolado`: semántica al-menos-una-vez,
 * puede duplicar ese envío en el peor caso.
 *
 * El rate limit es POR INSTANCIA (protege cada número por separado):
 * entre envíos de una misma instancia pasan `intervaloMs` más un jitter
 * aleatorio — cadencia perfectamente regular es señal de bot.
 *
 * TODO: la persistencia pasa a Firestore cuando entre; la interfaz de
 * esta clase no cambia.
 */

interface Pendiente {
  mensaje: Message;
  intentos: number;
  /** Epoch ms a partir del cual puede intentarse (backoff). */
  disponibleEn: number;
}

interface InstanciaRegistrada {
  id: InstanceId;
  transport: MessageTransport;
  intervaloMs: number;
  pendientes: Pendiente[];
  proximoPermitido: number;
  activa: boolean;
  despertar: (() => void) | null;
}

export interface ColaOpciones {
  /** Directorio de persistencia (un JSON por instancia). */
  dir: string;
  repo: Repositorio;
  /** Intervalo base entre envíos por instancia. */
  intervaloMs?: number;
  /** Jitter uniforme [0, jitterMaxMs) que se suma a cada intervalo. */
  jitterMaxMs?: number;
  /** Intentos totales antes de marcar `fallido`. */
  intentosMax?: number;
  /** Backoff: base * factor^(intento-1). */
  backoffBaseMs?: number;
  backoffFactor?: number;
}

export const COLA_DEFAULTS = {
  intervaloMs: 45_000,
  jitterMaxMs: 20_000,
  intentosMax: 3,
  backoffBaseMs: 60_000,
  backoffFactor: 4,
} as const;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ColaEnvios {
  readonly #dir: string;
  readonly #repo: Repositorio;
  readonly #opciones: Required<Omit<ColaOpciones, "dir" | "repo">>;
  #instancias = new Map<InstanceId, InstanciaRegistrada>();

  constructor(opciones: ColaOpciones) {
    this.#dir = opciones.dir;
    this.#repo = opciones.repo;
    this.#opciones = { ...COLA_DEFAULTS, ...opciones };
    mkdirSync(this.#dir, { recursive: true });
  }

  #archivo(instanceId: InstanceId): string {
    return join(this.#dir, `${instanceId}.json`);
  }

  #persistir(inst: InstanciaRegistrada): void {
    const ruta = this.#archivo(inst.id);
    const tmp = `${ruta}.tmp`;
    writeFileSync(tmp, JSON.stringify(inst.pendientes, null, 2));
    renameSync(tmp, ruta);
  }

  #cargar(instanceId: InstanceId): Pendiente[] {
    const ruta = this.#archivo(instanceId);
    if (!existsSync(ruta)) return [];
    try {
      const pendientes: Pendiente[] = JSON.parse(readFileSync(ruta, "utf8"));
      // Lo que quedó `enviando` en un crash vuelve a la cola.
      for (const p of pendientes) {
        if (p.mensaje.estado === "enviando") p.mensaje.estado = "encolado";
      }
      return pendientes;
    } catch {
      console.warn(`cola de ${instanceId} ilegible; se arranca vacía`);
      return [];
    }
  }

  /** Registra la instancia y arranca su worker; recarga pendientes del disco. */
  registrar(
    instanceId: InstanceId,
    transport: MessageTransport,
    opciones: { intervaloMs?: number } = {},
  ): void {
    if (this.#instancias.has(instanceId)) return;
    const inst: InstanciaRegistrada = {
      id: instanceId,
      transport,
      intervaloMs: opciones.intervaloMs ?? this.#opciones.intervaloMs,
      pendientes: this.#cargar(instanceId),
      proximoPermitido: 0,
      activa: true,
      despertar: null,
    };
    this.#instancias.set(instanceId, inst);
    for (const p of inst.pendientes) void this.#repo.saveMessage(p.mensaje);
    void this.#bucle(inst);
  }

  /** Detiene el worker; con borrarPendientes, descarta también el archivo. */
  baja(instanceId: InstanceId, borrarPendientes = false): void {
    const inst = this.#instancias.get(instanceId);
    if (!inst) return;
    inst.activa = false;
    inst.despertar?.();
    this.#instancias.delete(instanceId);
    if (borrarPendientes) {
      rmSync(this.#archivo(instanceId), { force: true });
    }
  }

  pendientes(instanceId: InstanceId): number {
    return this.#instancias.get(instanceId)?.pendientes.length ?? 0;
  }

  /** Encola y persiste; el mensaje queda `encolado` en el repositorio. */
  async encolar(mensaje: Message): Promise<void> {
    const inst = this.#instancias.get(mensaje.instanceId);
    if (!inst) {
      throw new Error(`instancia ${mensaje.instanceId} sin cola registrada`);
    }
    inst.pendientes.push({
      mensaje,
      intentos: 0,
      disponibleEn: 0,
    });
    this.#persistir(inst);
    await this.#repo.saveMessage(mensaje);
    inst.despertar?.();
  }

  async #bucle(inst: InstanciaRegistrada): Promise<void> {
    while (inst.activa) {
      const ahora = Date.now();
      const listo = inst.pendientes.find((p) => p.disponibleEn <= ahora);
      if (!listo) {
        await this.#esperar(inst, 500);
        continue;
      }
      if (ahora < inst.proximoPermitido) {
        await this.#esperar(inst, Math.min(inst.proximoPermitido - ahora, 1000));
        continue;
      }
      await this.#procesar(inst, listo);
    }
  }

  #esperar(inst: InstanciaRegistrada, ms: number): Promise<void> {
    return new Promise((resolver) => {
      const timer = setTimeout(() => {
        inst.despertar = null;
        resolver();
      }, ms);
      inst.despertar = () => {
        clearTimeout(timer);
        inst.despertar = null;
        resolver();
      };
    });
  }

  async #procesar(inst: InstanciaRegistrada, p: Pendiente): Promise<void> {
    const o = this.#opciones;
    p.mensaje.estado = "enviando";
    p.intentos += 1;
    this.#persistir(inst);
    await this.#repo.saveMessage({ ...p.mensaje });

    // La ventana de ritmo corre desde el intento, vaya bien o mal.
    inst.proximoPermitido =
      Date.now() + inst.intervaloMs + Math.floor(Math.random() * o.jitterMaxMs);

    try {
      const recibo = await inst.transport.send({
        telefono: p.mensaje.telefono,
        cuerpo: p.mensaje.cuerpo,
      });
      p.mensaje.estado = "enviado";
      p.mensaje.externalId = recibo.externalId;
      p.mensaje.timestamp = recibo.timestamp;
      inst.pendientes = inst.pendientes.filter((x) => x !== p);
      this.#persistir(inst);
      await this.#repo.saveMessage({ ...p.mensaje });
    } catch {
      if (p.intentos >= o.intentosMax) {
        p.mensaje.estado = "fallido";
        inst.pendientes = inst.pendientes.filter((x) => x !== p);
        this.#persistir(inst);
        await this.#repo.saveMessage({ ...p.mensaje });
      } else {
        p.mensaje.estado = "encolado";
        p.disponibleEn =
          Date.now() + o.backoffBaseMs * o.backoffFactor ** (p.intentos - 1);
        this.#persistir(inst);
        await this.#repo.saveMessage({ ...p.mensaje });
      }
    }
  }
}
