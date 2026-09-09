import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { DockerManager, RED, comandoAlcance, interpretarAlcance } from "./manager.ts";

describe("alcance del webhook (puro)", () => {
  it("arma un sh con getent y wget contra /health", () => {
    const [sh, c, script] = comandoAlcance("http://host.docker.internal:3001/");
    expect(sh).toBe("sh");
    expect(c).toBe("-c");
    expect(script).toContain("getent hosts host.docker.internal");
    expect(script).toContain('wget -q -O - -T 4 "http://host.docker.internal:3001/health"');
  });

  it("interpreta ok, nombre sin http, y nombre que no resuelve", () => {
    expect(interpretarAlcance("resuelve=172.17.0.1\nhttp=ok\n")).toMatchObject({
      ok: true, resuelve: "172.17.0.1",
    });
    const sinHttp = interpretarAlcance("resuelve=172.17.0.1\nhttp=fallo\n");
    expect(sinHttp.ok).toBe(false);
    expect(sinHttp.detalle).toMatch(/firewall/);
    const noResuelve = interpretarAlcance("resuelve=?\nhttp=fallo\n");
    expect(noResuelve).toMatchObject({ ok: false, resuelve: null });
    expect(noResuelve.detalle).toMatch(/no resuelve/);
  });
});

/**
 * Integración contra Docker real. Se omiten si no hay daemon corriendo.
 * Usan la primitiva genérica `lanzarContenedor` con busybox para no
 * pagar el arranque de Evolution en cada corrida; el ciclo con la
 * imagen real lo cubre scripts/prueba-ciclo.ts.
 */
const manager = new (class {
  instancia: DockerManager | null = null;
  disponible = false;
})();

try {
  manager.instancia = new DockerManager();
  manager.disponible = await manager.instancia.disponible();
} catch {
  manager.disponible = false;
}

const IMAGEN_PRUEBA = "busybox:1.36.1";
const creados: string[] = [];
const volumenes: string[] = [];

describe.skipIf(!manager.disponible)("DockerManager (integración)", () => {
  const docker = () => manager.instancia!;

  afterAll(async () => {
    // Primero fuera todos los contenedores; los volúmenes compartidos
    // entre pruebas solo se pueden borrar cuando nadie los usa.
    for (const id of creados) {
      await docker().eliminar(id, false);
    }
    for (const vol of volumenes) {
      await docker().eliminarVolumen(vol);
    }
  });

  it("verifica desde dentro del contenedor si alcanza al orquestador (host-gateway)", async () => {
    // Servidor /health en el host, puerto efímero, todas las interfaces.
    const servidor = createServer((_req, res) => res.end('{"ok":true}'));
    await new Promise<void>((r) => servidor.listen(0, "0.0.0.0", () => r()));
    const puerto = (servidor.address() as { port: number }).port;
    try {
      const id = await docker().lanzarContenedor({
        nombre: `cauce-test-alcance-${Date.now()}`,
        imagen: IMAGEN_PRUEBA,
        cmd: ["sleep", "300"],
      });
      creados.push(id);
      const ok = await docker().verificarAlcance(id, `http://host.docker.internal:${puerto}`);
      expect(ok.ok).toBe(true);
      expect(ok.resuelve).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      // Puerto sin nadie escuchando: el nombre resuelve pero /health no responde.
      const fallo = await docker().verificarAlcance(id, "http://host.docker.internal:1");
      expect(fallo.ok).toBe(false);
      expect(fallo.detalle).toMatch(/firewall/);
      await docker().detener(id);
    } finally {
      servidor.close();
    }
  }, 60_000);

  it("crea la red cauce-net de forma idempotente", async () => {
    await docker().asegurarRed();
    await docker().asegurarRed();
  });

  it("lanza un contenedor en cauce-net sin puertos publicados y reporta estado", async () => {
    const id = await docker().lanzarContenedor({
      nombre: `cauce-test-estado-${Date.now()}`,
      imagen: IMAGEN_PRUEBA,
      cmd: ["sleep", "300"],
    });
    creados.push(id);

    expect(await docker().estado(id)).toBe("corriendo");

    const info = await docker().inspeccionar(id);
    expect(info.HostConfig.NetworkMode).toBe(RED);
    const bindings = Object.values(info.NetworkSettings.Ports ?? {}).flat();
    expect(bindings.every((b) => b?.HostIp !== "0.0.0.0")).toBe(true);

    await docker().detener(id);
    expect(await docker().estado(id)).toBe("detenido");
  });

  it("estado devuelve ausente para un contenedor inexistente", async () => {
    expect(await docker().estado("no-existe-000")).toBe("ausente");
  });

  it("el volumen nombrado sobrevive a recrear el contenedor", async () => {
    const volumen = `cauce-auth-test-${Date.now()}`;
    volumenes.push(volumen);
    const primero = await docker().lanzarContenedor({
      nombre: `cauce-test-vol-a-${Date.now()}`,
      imagen: IMAGEN_PRUEBA,
      volumenes: { [volumen]: "/estado" },
      cmd: ["sh", "-c", "echo sesion-viva > /estado/credencial && sleep 300"],
    });
    creados.push(primero);
    await new Promise((r) => setTimeout(r, 1500));
    await docker().detener(primero);

    const segundo = await docker().lanzarContenedor({
      nombre: `cauce-test-vol-b-${Date.now()}`,
      imagen: IMAGEN_PRUEBA,
      volumenes: { [volumen]: "/estado" },
      cmd: ["sh", "-c", "cat /estado/credencial && sleep 300"],
    });
    creados.push(segundo);
    await new Promise((r) => setTimeout(r, 1500));

    expect(await docker().logs(segundo)).toContain("sesion-viva");
  });

  it("un contenedor resuelve a otro por hostname dentro de cauce-net", async () => {
    const objetivo = `cauce-test-dns-objetivo-${Date.now()}`;
    const idObjetivo = await docker().lanzarContenedor({
      nombre: objetivo,
      imagen: IMAGEN_PRUEBA,
      cmd: ["sleep", "300"],
    });
    creados.push(idObjetivo);

    const idCliente = await docker().lanzarContenedor({
      nombre: `cauce-test-dns-cliente-${Date.now()}`,
      imagen: IMAGEN_PRUEBA,
      cmd: ["sh", "-c", `ping -c 1 -W 3 ${objetivo} && echo RESUELVE && sleep 300`],
    });
    creados.push(idCliente);
    await new Promise((r) => setTimeout(r, 2500));

    expect(await docker().logs(idCliente)).toContain("RESUELVE");
  });
}, 120_000);
