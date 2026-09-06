import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import type { InstanceId, TenantId } from "@cauce/core";

/** Imagen de Evolution fijada con tag explícito. Nunca `latest`. */
export const IMAGEN_EVOLUTION = "evoapicloud/evolution-api:v2.3.7";
export const IMAGEN_POSTGRES = "postgres:16.6-alpine";

export const RED = "cauce-net";
const DB_CONTENEDOR = "cauce-db";
const DB_VOLUMEN = "cauce-db-data";
const DB_USUARIO = "cauce";
/** Label del contenedor de BD donde persiste su password generado. */
const LABEL_DB_PASSWORD = "cauce.db.password";

export type EstadoContenedor = "corriendo" | "detenido" | "ausente";

export interface ContenedorSpec {
  nombre: string;
  imagen: string;
  env?: Record<string, string>;
  /** { nombreVolumen: rutaDentroDelContenedor } */
  volumenes?: Record<string, string>;
  /**
   * Puerto interno a exponer SOLO en loopback del host (127.0.0.1,
   * puerto efímero). Nada se publica en interfaces externas.
   */
  puertoLoopback?: number;
  cmd?: string[];
  labels?: Record<string, string>;
}

function resolverSocket(): string {
  const porEnv = process.env.DOCKER_HOST;
  if (porEnv?.startsWith("unix://")) return porEnv.slice("unix://".length);
  const candidatos = [
    "/var/run/docker.sock",
    `${homedir()}/.colima/default/docker.sock`,
    `${homedir()}/.docker/run/docker.sock`,
  ];
  for (const ruta of candidatos) {
    if (existsSync(ruta)) return ruta;
  }
  throw new Error(
    "No se encontró el socket de Docker; define DOCKER_HOST o arranca el daemon",
  );
}

export function nombreContenedor(
  tenantId: TenantId,
  instanceId: InstanceId,
): string {
  return `cauce-${tenantId}-${instanceId}`;
}

export function nombreVolumenAuth(instanceId: InstanceId): string {
  return `cauce-auth-${instanceId}`;
}

function nombreBaseDatos(instanceId: InstanceId): string {
  return `cauce_inst_${instanceId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/**
 * Puerto libre en loopback, elegido por el kernel. Se fija explícito en
 * el binding del contenedor: un binding con puerto explícito sobrevive
 * reinicios del contenedor; uno efímero ("") se reasigna en cada start
 * y dejaría al orquestador apuntando a un puerto muerto.
 */
async function puertoLibre(): Promise<number> {
  return await new Promise((resolver, rechazar) => {
    const srv = createServer();
    srv.once("error", rechazar);
    srv.listen(0, "127.0.0.1", () => {
      const puerto = (srv.address() as { port: number }).port;
      srv.close(() => resolver(puerto));
    });
  });
}

export interface InstanciaEnDocker {
  contenedorId: string;
  tenantId: TenantId;
  instanceId: InstanceId;
  apiKey: string;
  webhookToken: string;
  baseUrl: string | null;
  corriendo: boolean;
}

export interface InstanciaCreada {
  contenedorId: string;
  /** Hostname del contenedor dentro de cauce-net. */
  hostname: string;
  /** URL alcanzable desde el orquestador (loopback del host). */
  baseUrl: string;
}

export class DockerManager {
  readonly #docker: Docker;

  constructor(docker?: Docker) {
    this.#docker = docker ?? new Docker({ socketPath: resolverSocket() });
  }

  async disponible(): Promise<boolean> {
    try {
      await this.#docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async asegurarRed(): Promise<void> {
    const redes = await this.#docker.listNetworks({
      filters: { name: [RED] },
    });
    if (!redes.some((r) => r.Name === RED)) {
      await this.#docker.createNetwork({ Name: RED, Driver: "bridge" });
    }
  }

  async asegurarImagen(imagen: string): Promise<void> {
    try {
      await this.#docker.getImage(imagen).inspect();
    } catch {
      const stream = await this.#docker.pull(imagen);
      await new Promise((resolver, rechazar) => {
        this.#docker.modem.followProgress(stream, (err) =>
          err ? rechazar(err) : resolver(null),
        );
      });
    }
  }

  /**
   * Arranca (o reutiliza) el Postgres compartido de la flota en cauce-net.
   * Su password se genera una vez y persiste como label del contenedor.
   *
   * TODO: en producción el password va en Google Secret Manager; el label
   * es equivalente en riesgo a tener el socket (quien lee el socket ya es
   * root del host), pero no es un lugar de secretos a largo plazo.
   */
  async asegurarBaseDatos(): Promise<void> {
    await this.asegurarRed();
    const existente = await this.#inspeccionarPorNombre(DB_CONTENEDOR);
    if (existente) {
      if (existente.State.Running) return;
      await this.#docker.getContainer(existente.Id).start();
      await this.#esperarPostgres();
      return;
    }
    await this.asegurarImagen(IMAGEN_POSTGRES);
    const password = randomBytes(24).toString("hex");
    const contenedor = await this.#docker.createContainer({
      name: DB_CONTENEDOR,
      Image: IMAGEN_POSTGRES,
      Env: [
        `POSTGRES_USER=${DB_USUARIO}`,
        `POSTGRES_PASSWORD=${password}`,
        "POSTGRES_DB=cauce",
      ],
      Labels: { [LABEL_DB_PASSWORD]: password, "cauce.rol": "db" },
      HostConfig: {
        NetworkMode: RED,
        Binds: [`${DB_VOLUMEN}:/var/lib/postgresql/data`],
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    await contenedor.start();
    await this.#esperarPostgres();
  }

  async #passwordBaseDatos(): Promise<string> {
    const info = await this.#inspeccionarPorNombre(DB_CONTENEDOR);
    const password = info?.Config.Labels?.[LABEL_DB_PASSWORD];
    if (!password) {
      throw new Error("El contenedor cauce-db no existe o no tiene password");
    }
    return password;
  }

  async #esperarPostgres(timeoutMs = 60_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      const salida = await this.#exec(DB_CONTENEDOR, [
        "pg_isready",
        "-U",
        DB_USUARIO,
      ]);
      if (salida.includes("accepting connections")) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Postgres no quedó listo dentro del timeout");
  }

  async #crearBaseDatos(nombre: string): Promise<void> {
    const salida = await this.#exec(DB_CONTENEDOR, [
      "psql",
      "-U",
      DB_USUARIO,
      "-tc",
      `SELECT 1 FROM pg_database WHERE datname = '${nombre}'`,
    ]);
    if (salida.includes("1")) return;
    await this.#exec(DB_CONTENEDOR, ["createdb", "-U", DB_USUARIO, nombre]);
  }

  async #exec(nombreCont: string, cmd: string[]): Promise<string> {
    const contenedor = this.#docker.getContainer(nombreCont);
    const exec = await contenedor.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    return await new Promise<string>((resolver, rechazar) => {
      const trozos: Buffer[] = [];
      stream.on("data", (d: Buffer) => trozos.push(d));
      stream.on("end", () => resolver(Buffer.concat(trozos).toString("utf8")));
      stream.on("error", rechazar);
    });
  }

  /**
   * Primitiva genérica: contenedor en cauce-net, sin puertos publicados
   * salvo el binding opcional a loopback. `crear()` arma sobre esto la
   * spec de Evolution; las pruebas de integración la usan directo.
   */
  async lanzarContenedor(spec: ContenedorSpec): Promise<string> {
    await this.asegurarRed();
    await this.asegurarImagen(spec.imagen);
    const config: Docker.ContainerCreateOptions = {
      name: spec.nombre,
      Image: spec.imagen,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: { "cauce.rol": "instancia", ...spec.labels },
      HostConfig: {
        NetworkMode: RED,
        Binds: Object.entries(spec.volumenes ?? {}).map(
          ([vol, ruta]) => `${vol}:${ruta}`,
        ),
        RestartPolicy: { Name: "unless-stopped" },
        // El contenedor necesita alcanzar al orquestador (webhooks), que
        // corre en el host: host-gateway resuelve ese destino.
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    };
    if (spec.puertoLoopback !== undefined) {
      const puertoHost = await puertoLibre();
      config.ExposedPorts = { [`${spec.puertoLoopback}/tcp`]: {} };
      config.HostConfig!.PortBindings = {
        [`${spec.puertoLoopback}/tcp`]: [
          { HostIp: "127.0.0.1", HostPort: String(puertoHost) },
        ],
      };
    }
    if (spec.cmd) config.Cmd = spec.cmd;
    const contenedor = await this.#docker.createContainer(config);
    await contenedor.start();
    return contenedor.id;
  }

  /**
   * Crea la sesión de Evolution para una instancia: contenedor propio en
   * cauce-net, volumen nombrado para el estado, base de datos propia en
   * el Postgres compartido, API key única, sin puertos hacia fuera.
   */
  async crear(
    tenantId: TenantId,
    instanceId: InstanceId,
    opciones: { apiKey: string; webhookToken: string },
  ): Promise<InstanciaCreada> {
    await this.asegurarBaseDatos();
    const bd = nombreBaseDatos(instanceId);
    await this.#crearBaseDatos(bd);
    const password = await this.#passwordBaseDatos();
    const nombre = nombreContenedor(tenantId, instanceId);

    const contenedorId = await this.lanzarContenedor({
      nombre,
      imagen: IMAGEN_EVOLUTION,
      puertoLoopback: 8080,
      volumenes: { [nombreVolumenAuth(instanceId)]: "/evolution/instances" },
      // apiKey y webhookToken viven como labels para poder rehidratar
      // sesiones tras un reinicio del orquestador. Mismo criterio que
      // el password de la BD: quien lee el socket ya es root del host.
      // TODO: moverlos a Google Secret Manager.
      labels: {
        "cauce.tenant": tenantId,
        "cauce.instance": instanceId,
        "cauce.apikey": opciones.apiKey,
        "cauce.webhook-token": opciones.webhookToken,
      },
      env: {
        SERVER_PORT: "8080",
        AUTHENTICATION_API_KEY: opciones.apiKey,
        DATABASE_ENABLED: "true",
        DATABASE_PROVIDER: "postgresql",
        DATABASE_CONNECTION_URI: `postgresql://${DB_USUARIO}:${password}@${DB_CONTENEDOR}:5432/${bd}?schema=public`,
        DATABASE_CONNECTION_CLIENT_NAME: nombre,
        DATABASE_SAVE_DATA_INSTANCE: "true",
        DATABASE_SAVE_MESSAGE_UPDATE: "false",
        CACHE_LOCAL_ENABLED: "true",
        CACHE_REDIS_ENABLED: "false",
        // Nombre que aparece en WhatsApp → Dispositivos vinculados.
        // Sin esto Evolution reporta "Google Chrome".
        CONFIG_SESSION_PHONE_CLIENT: "Cauce",
        CONFIG_SESSION_PHONE_NAME: "Chrome",
        // El webhook NO se configura por env: en v2.3.7 el webhook
        // global por variables no dispara (verificado). Se registra por
        // instancia vía POST /webhook/set en EvolutionTransport.connect.
        LOG_LEVEL: "ERROR,WARN,INFO",
      },
    });

    const baseUrl = await this.baseUrlLocal(contenedorId);
    return { contenedorId, hostname: nombre, baseUrl };
  }

  /** URL loopback (127.0.0.1:puerto-efímero) del puerto 8080 del contenedor. */
  async baseUrlLocal(contenedorId: string): Promise<string> {
    const info = await this.#docker.getContainer(contenedorId).inspect();
    const binding = info.NetworkSettings.Ports?.["8080/tcp"]?.[0];
    if (!binding?.HostPort) {
      throw new Error(`El contenedor ${contenedorId} no tiene binding loopback`);
    }
    return `http://127.0.0.1:${binding.HostPort}`;
  }

  async detener(contenedorId: string): Promise<void> {
    const estado = await this.estado(contenedorId);
    if (estado !== "corriendo") return;
    await this.#docker.getContainer(contenedorId).stop({ t: 10 });
  }

  async arrancar(contenedorId: string): Promise<void> {
    await this.#docker.getContainer(contenedorId).start();
  }

  async eliminar(contenedorId: string, borrarVolumen: boolean): Promise<void> {
    const contenedor = this.#docker.getContainer(contenedorId);
    let volumenes: string[] = [];
    try {
      const info = await contenedor.inspect();
      volumenes = (info.Mounts ?? [])
        .filter((m) => m.Type === "volume" && m.Name?.startsWith("cauce-auth-"))
        .map((m) => m.Name!);
      await contenedor.remove({ force: true });
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
    if (borrarVolumen) {
      for (const vol of volumenes) {
        await this.eliminarVolumen(vol);
      }
    }
  }

  async eliminarVolumen(nombre: string): Promise<void> {
    try {
      await this.#docker.getVolume(nombre).remove();
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
  }

  /**
   * Instancias de la flota según Docker: contenedores con rol
   * `instancia` y sus labels. Fuente de verdad para rehidratar el
   * orquestador tras un reinicio.
   */
  async listarInstancias(): Promise<InstanciaEnDocker[]> {
    const contenedores = await this.#docker.listContainers({
      all: true,
      filters: { label: ["cauce.rol=instancia"] },
    });
    const resultado: InstanciaEnDocker[] = [];
    for (const c of contenedores) {
      const labels = c.Labels ?? {};
      const tenantId = labels["cauce.tenant"];
      const instanceId = labels["cauce.instance"];
      const apiKey = labels["cauce.apikey"];
      const webhookToken = labels["cauce.webhook-token"];
      if (!tenantId || !instanceId || !apiKey || !webhookToken) {
        console.warn(
          `contenedor ${c.Names?.[0] ?? c.Id.slice(0, 12)} tiene rol instancia pero labels incompletos; se ignora`,
        );
        continue;
      }
      let baseUrl: string | null = null;
      try {
        baseUrl = await this.baseUrlLocal(c.Id);
      } catch {
        // Sin binding loopback no es operable desde el orquestador.
      }
      resultado.push({
        contenedorId: c.Id,
        tenantId,
        instanceId,
        apiKey,
        webhookToken,
        baseUrl,
        corriendo: c.State === "running",
      });
    }
    return resultado;
  }

  async inspeccionar(contenedorId: string) {
    return this.#docker.getContainer(contenedorId).inspect();
  }

  async logs(contenedorId: string): Promise<string> {
    const buffer = await this.#docker.getContainer(contenedorId).logs({
      stdout: true,
      stderr: true,
    });
    return buffer.toString("utf8");
  }

  async estado(contenedorId: string): Promise<EstadoContenedor> {
    try {
      const info = await this.#docker.getContainer(contenedorId).inspect();
      return info.State.Running ? "corriendo" : "detenido";
    } catch (err: any) {
      if (err?.statusCode === 404) return "ausente";
      throw err;
    }
  }

  /**
   * Poll al endpoint raíz de la instancia hasta que responda 200 o venza
   * el timeout. El primer arranque corre migraciones de BD: es lento.
   */
  async esperarListo(baseUrl: string, timeoutMs = 120_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    let ultimoError = "sin respuesta";
    while (Date.now() < limite) {
      try {
        const res = await fetch(baseUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.status === 200) return;
        ultimoError = `status ${res.status}`;
      } catch (err: any) {
        ultimoError = err?.cause?.code ?? err?.message ?? String(err);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(
      `La instancia en ${baseUrl} no quedó lista en ${timeoutMs}ms (${ultimoError})`,
    );
  }

  async #inspeccionarPorNombre(nombre: string) {
    try {
      return await this.#docker.getContainer(nombre).inspect();
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }
}
