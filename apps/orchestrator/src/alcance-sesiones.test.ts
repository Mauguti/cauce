import { describe, expect, it } from "vitest";
import { GestorSesiones } from "./sesiones.ts";
import { RepositorioEnMemoria } from "./store.ts";
import type { DockerManager } from "./docker/manager.ts";

/**
 * La sonda de alcance del webhook no debe correr durante rehidratar():
 * en ese momento el orquestador aún no escucha y "/health no responde"
 * sería siempre un fallo falso. Corre después, desde comprobarAlcanceSesiones().
 */
function dobleDocker(instancias: { tenantId: string; instanceId: string }[]) {
  const llamadas: string[] = [];
  const docker = {
    listarInstancias: async () =>
      instancias.map((i) => ({
        contenedorId: `cont-${i.instanceId}`,
        tenantId: i.tenantId,
        instanceId: i.instanceId,
        apiKey: "k",
        webhookToken: "w",
        baseUrl: "http://127.0.0.1:1", // nadie escucha: el transporte reporta desconectada rápido
        corriendo: true,
      })),
    verificarAlcance: async (contenedorId: string) => {
      llamadas.push(contenedorId);
      return { ok: true, resuelve: "172.17.0.1", detalle: "health respondió desde el contenedor" };
    },
  } as unknown as DockerManager;
  return { docker, llamadas };
}

describe("sonda de alcance del webhook", () => {
  it("rehidratar() NO sondea; comprobarAlcanceSesiones() sondea una vez por sesión viva", async () => {
    const repo = new RepositorioEnMemoria({
      tenants: [{ id: "t1", nombre: "T", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z" }],
    });
    const { docker, llamadas } = dobleDocker([
      { tenantId: "t1", instanceId: "i1" },
      { tenantId: "t1", instanceId: "i2" },
    ]);
    const gestor = new GestorSesiones({ docker, repo, urlPublica: "http://host.docker.internal:3001" });

    expect(await gestor.rehidratar()).toBe(2);
    expect(llamadas).toEqual([]); // nada durante la rehidratación

    expect(await gestor.comprobarAlcanceSesiones()).toBe(0); // 0 fallos
    expect(llamadas.sort()).toEqual(["cont-i1", "cont-i2"]);
  }, 20_000);

  it("sin sesiones vivas, la sonda diferida no hace nada", async () => {
    const repo = new RepositorioEnMemoria();
    const { docker, llamadas } = dobleDocker([]);
    const gestor = new GestorSesiones({ docker, repo, urlPublica: "http://host.docker.internal:3001" });
    expect(await gestor.comprobarAlcanceSesiones()).toBe(0);
    expect(llamadas).toEqual([]);
  });
});
