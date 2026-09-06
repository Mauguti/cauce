import { randomBytes, randomUUID } from "node:crypto";
import {
  pruebaVigente,
  type Instance,
  type InstanceId,
  type Message,
  type TenantId,
} from "@cauce/core";
import { createTransport, type MessageTransport } from "@cauce/transports";
import { diagnosticarEnvio, telefonoValido } from "./errores.ts";
import type { ColaEnvios } from "./cola.ts";
import { DockerManager, nombreContenedor } from "./docker/manager.ts";
import type { Repositorio } from "./store.ts";

export interface SesionActiva {
  transport: MessageTransport;
  contenedorId: string;
  baseUrl: string;
  /** Token que Evolution manda de vuelta en la URL del webhook. */
  webhookToken: string;
}

/**
 * Mantiene el vínculo instancia → transporte/contenedor. Vive en memoria:
 * si el orquestador se reinicia, los contenedores siguen corriendo pero
 * hay que rehidratar este mapa.
 *
 * TODO: persistir apiKey/webhookToken en Google Secret Manager y
 * rehidratar sesiones desde los labels de los contenedores al arrancar.
 */
export class GestorSesiones {
  readonly #docker: DockerManager;
  readonly #repo: Repositorio;
  readonly #urlPublica: string;
  readonly #cola: ColaEnvios | null;
  #sesiones = new Map<InstanceId, SesionActiva>();

  constructor(opciones: {
    docker: DockerManager;
    repo: Repositorio;
    /**
     * Base con la que los contenedores alcanzan al orquestador para
     * webhooks. En dev con el orquestador en el host es
     * http://host.docker.internal:<puerto>.
     */
    urlPublica: string;
    /** Cola de envíos; opcional para pruebas que no envían. */
    cola?: ColaEnvios;
  }) {
    this.#docker = opciones.docker;
    this.#repo = opciones.repo;
    this.#urlPublica = opciones.urlPublica.replace(/\/$/, "");
    this.#cola = opciones.cola ?? null;
  }

  async #registrarEnCola(
    tenantId: TenantId,
    instanceId: InstanceId,
    transport: MessageTransport,
  ): Promise<void> {
    if (!this.#cola) return;
    const tenant = await this.#repo.getTenant(tenantId);
    this.#cola.registrar(instanceId, transport, {
      ...(tenant?.envioIntervaloMs !== undefined
        ? { intervaloMs: tenant.envioIntervaloMs }
        : {}),
    });
  }

  obtener(instanceId: InstanceId): SesionActiva | null {
    return this.#sesiones.get(instanceId) ?? null;
  }

  /**
   * ÚNICO lugar que decide con qué nombre vive la instancia en Evolution
   * y a qué webhook apunta. Creación y envío (y todo el ciclo de vida)
   * comparten este transporte, así que no pueden divergir: el bug de
   * "creada como cauce-{t}-{i} pero enviando a {i}" no puede reaparecer
   * mientras el transporte se construya solo por aquí.
   */
  #construirTransporte(opciones: {
    tenantId: TenantId;
    instanceId: InstanceId;
    baseUrl: string;
    apiKey: string;
    webhookToken: string;
  }): MessageTransport {
    const { tenantId, instanceId, baseUrl, apiKey, webhookToken } = opciones;
    return createTransport({
      tipo: "evolution",
      opciones: {
        baseUrl,
        apiKey,
        instanceName: nombreContenedor(tenantId, instanceId),
        webhookUrl: `${this.#urlPublica}/webhooks/${tenantId}/${instanceId}?token=${webhookToken}`,
      },
    });
  }

  /**
   * Carril inmediato: envía SIN pasar por la cola ni su rate limiting.
   * Responder dentro de una conversación activa es seguro y debe ser
   * instantáneo; el espaciado de 45-65s solo protege envíos proactivos.
   * Persiste el mensaje saliente como cualquier otro.
   */
  async enviarDirecto(
    tenantId: TenantId,
    instanceId: InstanceId,
    telefono: string,
    cuerpo: string,
  ): Promise<Message> {
    const sesion = this.#sesiones.get(instanceId);
    if (!sesion) throw new Error(`instancia ${instanceId} sin sesión activa`);
    const mensaje: Message = {
      id: randomUUID(),
      tenantId,
      instanceId,
      direccion: "out",
      telefono,
      cuerpo,
      estado: "enviando",
      externalId: null,
      timestamp: new Date().toISOString(),
    };
    try {
      if (!telefonoValido(telefono)) {
        throw new Error("teléfono inválido (formato)");
      }
      const recibo = await sesion.transport.send({ telefono, cuerpo });
      mensaje.estado = "enviado";
      mensaje.externalId = recibo.externalId;
    } catch (err: any) {
      const diag = diagnosticarEnvio(err?.message ?? String(err));
      mensaje.estado = "fallido";
      mensaje.error = diag.mensaje;
      mensaje.errorCodigo = diag.codigo;
    }
    await this.#repo.saveMessage(mensaje);
    return mensaje;
  }

  /**
   * Reconstruye las sesiones desde Docker tras un reinicio del
   * orquestador: los contenedores con labels de la flota son la fuente
   * de verdad. Un contenedor cuyo tenant no existe en el repositorio se
   * reporta y se deja intacto — nunca se borra desde aquí.
   */
  async rehidratar(): Promise<number> {
    let rehidratadas = 0;
    for (const enDocker of await this.#docker.listarInstancias()) {
      const tenant = await this.#repo.getTenant(enDocker.tenantId);
      if (!tenant) {
        console.warn(
          `contenedor de instancia ${enDocker.instanceId} pertenece al tenant desconocido "${enDocker.tenantId}"; se deja corriendo sin registrar`,
        );
        continue;
      }
      if (!enDocker.baseUrl) {
        console.warn(
          `instancia ${enDocker.instanceId} sin binding loopback; se omite`,
        );
        continue;
      }
      const transport = this.#construirTransporte({
        tenantId: enDocker.tenantId,
        instanceId: enDocker.instanceId,
        baseUrl: enDocker.baseUrl,
        apiKey: enDocker.apiKey,
        webhookToken: enDocker.webhookToken,
      });
      const estado = await transport.status();
      await this.#repo.saveInstance({
        id: enDocker.instanceId,
        tenantId: enDocker.tenantId,
        transportType: "evolution",
        contenedorId: enDocker.contenedorId,
        numero: null,
        estado,
        ultimoHeartbeat: new Date().toISOString(),
      });
      this.#sesiones.set(enDocker.instanceId, {
        transport,
        contenedorId: enDocker.contenedorId,
        baseUrl: enDocker.baseUrl,
        webhookToken: enDocker.webhookToken,
      });
      await this.#registrarEnCola(
        enDocker.tenantId,
        enDocker.instanceId,
        transport,
      );
      rehidratadas += 1;
    }
    return rehidratadas;
  }

  async crear(tenantId: TenantId): Promise<Instance> {
    const instanceId = randomUUID().slice(0, 8);
    const apiKey = randomBytes(24).toString("hex");
    const webhookToken = randomBytes(24).toString("hex");

    const creada = await this.#docker.crear(tenantId, instanceId, {
      apiKey,
      webhookToken,
    });
    await this.#docker.esperarListo(creada.baseUrl);

    const transport = this.#construirTransporte({
      tenantId,
      instanceId,
      baseUrl: creada.baseUrl,
      apiKey,
      webhookToken,
    });
    await transport.connect();

    const instancia: Instance = {
      id: instanceId,
      tenantId,
      transportType: "evolution",
      contenedorId: creada.contenedorId,
      numero: null,
      estado: "pending",
      ultimoHeartbeat: null,
    };
    await this.#repo.saveInstance(instancia);
    this.#sesiones.set(instanceId, {
      transport,
      contenedorId: creada.contenedorId,
      baseUrl: creada.baseUrl,
      webhookToken,
    });
    await this.#registrarEnCola(tenantId, instanceId, transport);
    return instancia;
  }

  /** Refresca el estado desde el transporte y lo persiste. */
  async refrescar(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<Instance | null> {
    const instancia = await this.#repo.getInstance(tenantId, instanceId);
    const sesion = this.#sesiones.get(instanceId);
    if (!instancia || !sesion) return instancia;
    const estado = await sesion.transport.status();
    // Al conectar, captura el número real una sola vez (no se conoce
    // hasta que la sesión conecta); así la UI muestra el número, no el id.
    let numero = instancia.numero;
    if (estado === "connected" && !numero) {
      numero = (await sesion.transport.numero()) ?? null;
    }
    const actualizada: Instance = {
      ...instancia,
      estado,
      numero,
      ultimoHeartbeat: new Date().toISOString(),
    };
    await this.#repo.saveInstance(actualizada);
    return actualizada;
  }

  /**
   * Desconecta (logout de Evolution) conservando contenedor y registro,
   * para poder reconectar sin recrear. El número se olvida: al reconectar
   * podría vincularse otro.
   */
  async desconectar(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<Instance | null> {
    const instancia = await this.#repo.getInstance(tenantId, instanceId);
    const sesion = this.#sesiones.get(instanceId);
    if (!instancia || !sesion) return instancia;
    await sesion.transport.disconnect();
    const actualizada: Instance = {
      ...instancia,
      estado: "disconnected",
      numero: null,
      ultimoHeartbeat: new Date().toISOString(),
    };
    await this.#repo.saveInstance(actualizada);
    return actualizada;
  }

  /**
   * Reconecta una sesión desconectada: pide sesión de nuevo, lo que
   * vuelve a emitir QR. El contenedor y el volumen ya existen.
   */
  async reconectar(
    tenantId: TenantId,
    instanceId: InstanceId,
  ): Promise<Instance | null> {
    const instancia = await this.#repo.getInstance(tenantId, instanceId);
    const sesion = this.#sesiones.get(instanceId);
    if (!instancia || !sesion) return instancia;
    await sesion.transport.connect();
    return this.refrescar(tenantId, instanceId);
  }

  async eliminar(tenantId: TenantId, instanceId: InstanceId): Promise<void> {
    this.#cola?.baja(instanceId, true);
    const sesion = this.#sesiones.get(instanceId);
    if (sesion) {
      try {
        await sesion.transport.disconnect();
      } catch {
        // El contenedor puede estar ya caído; la limpieza sigue.
      }
      await this.#docker.detener(sesion.contenedorId);
      await this.#docker.eliminar(sesion.contenedorId, true);
      this.#sesiones.delete(instanceId);
    }
    await this.#repo.deleteInstance(tenantId, instanceId);
  }

  /**
   * Vence las pruebas caducadas: DESCONECTA (logout) las sesiones aún
   * vivas de tenants con prueba vencida, SIN destruir contenedor, volumen
   * ni datos. Un cliente que paga tarde no pierde su vinculación ni sus
   * conversaciones. Idempotente: solo toca sesiones no-desconectadas.
   * Devuelve cuántas sesiones desconectó.
   */
  async vencerPruebas(): Promise<number> {
    let desconectadas = 0;
    for (const tenant of await this.#repo.listTenants()) {
      if (pruebaVigente(tenant)) continue;
      for (const inst of await this.#repo.listInstances(tenant.id)) {
        if (inst.estado === "disconnected") continue;
        if (!this.#sesiones.has(inst.id)) continue;
        try {
          await this.desconectar(tenant.id, inst.id);
          desconectadas += 1;
        } catch {
          // El contenedor puede estar caído; se reintenta en el próximo barrido.
        }
      }
    }
    return desconectadas;
  }
}
