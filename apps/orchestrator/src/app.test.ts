import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "./app.ts";
import { RepositorioEnMemoria } from "./store.ts";

function levantar() {
  const repo = new RepositorioEnMemoria({
    tenants: [
      { id: "a", nombre: "A", plan: "basico", estado: "activo", creadoEn: "2026-09-05T00:00:00Z" },
      { id: "b", nombre: "B", plan: "basico", estado: "activo", creadoEn: "2026-09-05T00:00:00Z" },
    ],
    instances: [
      { id: "i1", tenantId: "a", transportType: "mock", contenedorId: null, numero: "+521", estado: "connected", ultimoHeartbeat: null },
      { id: "i2", tenantId: "b", transportType: "mock", contenedorId: null, numero: "+522", estado: "pending", ultimoHeartbeat: null },
    ],
  });
  const server = crearApp(repo).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, cerrar: () => server.close() };
}

describe("orquestador", () => {
  it("responde health", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    } finally {
      cerrar();
    }
  });

  it("lista solo instancias del tenant scopeado", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/a/instances`);
      const instancias = await res.json();
      expect(instancias).toHaveLength(1);
      expect(instancias[0].id).toBe("i1");
      expect(instancias.every((i: { tenantId: string }) => i.tenantId === "a")).toBe(true);
    } finally {
      cerrar();
    }
  });

  it("no expone instancias de otro tenant por id", async () => {
    const { base, cerrar } = levantar();
    try {
      // i2 pertenece al tenant b: pedirla scopeada en a debe dar 404.
      const res = await fetch(`${base}/api/tenants/a/instances/i2`);
      expect(res.status).toBe(404);
    } finally {
      cerrar();
    }
  });

  it("devuelve 404 para tenant inexistente", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/nope/instances`);
      expect(res.status).toBe(404);
    } finally {
      cerrar();
    }
  });
});
