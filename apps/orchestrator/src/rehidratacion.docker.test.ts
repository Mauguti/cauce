import { afterAll, describe, expect, it } from "vitest";
import { DockerManager } from "./docker/manager.ts";
import { GestorSesiones } from "./sesiones.ts";
import { RepositorioEnMemoria } from "./store.ts";
import type { Tenant } from "@cauce/core";

/**
 * Integración contra Docker + Evolution reales: una sesión creada por un
 * proceso debe poder rehidratarse en un proceso nuevo (reinicio del
 * orquestador) solo a partir de lo que Docker sabe.
 */
let disponible = false;
let docker: DockerManager | null = null;
try {
  docker = new DockerManager();
  disponible = await docker.disponible();
} catch {
  disponible = false;
}

const TENANT: Tenant = {
  id: "rehtest",
  nombre: "Rehidratación",
  plan: "basico",
  estado: "activo",
  apiKeyHash: "x".repeat(64),
  creadoEn: "2026-09-05T00:00:00Z",
};

function nuevoGestor() {
  const repo = new RepositorioEnMemoria({ tenants: [TENANT] });
  const gestor = new GestorSesiones({
    docker: docker!,
    repo,
    urlPublica: "http://host.docker.internal:3999",
  });
  return { repo, gestor };
}

let instanceId: string | null = null;
let gestorLimpieza: GestorSesiones | null = null;

describe.skipIf(!disponible)("rehidratación de sesiones", () => {
  afterAll(async () => {
    if (instanceId && gestorLimpieza) {
      await gestorLimpieza.eliminar(TENANT.id, instanceId);
    }
  }, 60_000);

  it("una sesión creada sobrevive al reinicio del proceso", async () => {
    const procesoA = nuevoGestor();
    const instancia = await procesoA.gestor.crear(TENANT.id);
    instanceId = instancia.id;
    gestorLimpieza = procesoA.gestor;

    // "Reinicio": proceso nuevo, repositorio vacío, sin memoria previa.
    const procesoB = nuevoGestor();
    expect(await procesoB.repo.listInstances(TENANT.id)).toHaveLength(0);

    const rehidratadas = await procesoB.gestor.rehidratar();
    expect(rehidratadas).toBeGreaterThanOrEqual(1);

    const listadas = await procesoB.repo.listInstances(TENANT.id);
    const mia = listadas.find((i) => i.id === instanceId);
    expect(mia).toBeDefined();
    expect(mia!.contenedorId).toBe(instancia.contenedorId);

    // Operable: la sesión responde estado real y puede pedir QR.
    const sesion = procesoB.gestor.obtener(instanceId!);
    expect(sesion).not.toBeNull();
    const estado = await sesion!.transport.status();
    expect(["pending", "qr", "connected"]).toContain(estado);

    gestorLimpieza = procesoB.gestor;
  }, 240_000);
});
