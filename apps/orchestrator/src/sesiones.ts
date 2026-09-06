import { randomBytes, randomUUID } from "node:crypto";
import type { Instance, InstanceId, TenantId } from "@cauce/core";
import { createTransport, type MessageTransport } from "@cauce/transports";
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
  }) {
    this.#docker = opciones.docker;
    this.#repo = opciones.repo;
    this.#urlPublica = opciones.urlPublica.replace(/\/$/, "");
  }

  obtener(instanceId: InstanceId): SesionActiva | null {
    return this.#sesiones.get(instanceId) ?? null;
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
      const transport = createTransport({
        tipo: "evolution",
        opciones: {
          baseUrl: enDocker.baseUrl,
          apiKey: enDocker.apiKey,
          instanceName: nombreContenedor(
            enDocker.tenantId,
            enDocker.instanceId,
          ),
          webhookUrl: `${this.#urlPublica}/webhooks/${enDocker.tenantId}/${enDocker.instanceId}?token=${enDocker.webhookToken}`,
        },
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
      rehidratadas += 1;
    }
    return rehidratadas;
  }

  async crear(tenantId: TenantId): Promise<Instance> {
    const instanceId = randomUUID().slice(0, 8);
    const apiKey = randomBytes(24).toString("hex");
    const webhookToken = randomBytes(24).toString("hex");

    const webhookUrl = `${this.#urlPublica}/webhooks/${tenantId}/${instanceId}?token=${webhookToken}`;
    const creada = await this.#docker.crear(tenantId, instanceId, {
      apiKey,
      webhookToken,
    });
    await this.#docker.esperarListo(creada.baseUrl);

    const transport = createTransport({
      tipo: "evolution",
      opciones: {
        baseUrl: creada.baseUrl,
        apiKey,
        instanceName: nombreContenedor(tenantId, instanceId),
        webhookUrl,
      },
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
    const actualizada: Instance = {
      ...instancia,
      estado,
      ultimoHeartbeat: new Date().toISOString(),
    };
    await this.#repo.saveInstance(actualizada);
    return actualizada;
  }

  async eliminar(tenantId: TenantId, instanceId: InstanceId): Promise<void> {
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
}
