import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { RepositorioEnMemoria } from "./store.ts";

const KEY_A = "key-tenant-a-0000000000000000";
const KEY_B = "key-tenant-b-1111111111111111";

function levantar() {
  const repo = new RepositorioEnMemoria({
    tenants: [
      { id: "a", nombre: "A", plan: "basico", estado: "activo", apiKeyHash: hashApiKey(KEY_A), creadoEn: "2026-09-05T00:00:00Z" },
      { id: "b", nombre: "B", plan: "basico", estado: "activo", apiKeyHash: hashApiKey(KEY_B), creadoEn: "2026-09-05T00:00:00Z" },
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

const conKey = (key: string) => ({ headers: { "x-api-key": key } });

describe("orquestador", () => {
  it("responde health sin auth", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    } finally {
      cerrar();
    }
  });

  it("lista solo instancias del tenant dueño de la key", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/a/instances`, conKey(KEY_A));
      expect(res.status).toBe(200);
      const instancias = await res.json();
      expect(instancias).toHaveLength(1);
      expect(instancias[0].id).toBe("i1");
    } finally {
      cerrar();
    }
  });

  it("rechaza sin key y con key inválida, sin filtrar existencia", async () => {
    const { base, cerrar } = levantar();
    try {
      const sinKey = await fetch(`${base}/api/tenants/a/instances`);
      expect(sinKey.status).toBe(401);

      const keyMala = await fetch(
        `${base}/api/tenants/a/instances`,
        conKey("key-adivinada"),
      );
      expect(keyMala.status).toBe(401);
      // Mismo cuerpo para tenant existente e inexistente.
      const inexistente = await fetch(
        `${base}/api/tenants/nope/instances`,
        conKey("key-adivinada"),
      );
      expect(inexistente.status).toBe(401);
      expect(await keyMala.text()).toBe(await inexistente.text());
    } finally {
      cerrar();
    }
  });

  it("key del tenant A contra recursos del tenant B → 401", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/b/instances`, conKey(KEY_A));
      expect(res.status).toBe(401);

      const porId = await fetch(
        `${base}/api/tenants/b/instances/i2`,
        conKey(KEY_A),
      );
      expect(porId.status).toBe(401);
    } finally {
      cerrar();
    }
  });

  it("el tenant sale de la key: una instancia ajena por id da 404", async () => {
    const { base, cerrar } = levantar();
    try {
      // i2 es del tenant b; con la key de A (y path de A) no existe.
      const res = await fetch(
        `${base}/api/tenants/a/instances/i2`,
        conKey(KEY_A),
      );
      expect(res.status).toBe(404);
    } finally {
      cerrar();
    }
  });

  it("acepta la key también como Bearer", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/a/instances`, {
        headers: { authorization: `Bearer ${KEY_A}` },
      });
      expect(res.status).toBe(200);
    } finally {
      cerrar();
    }
  });
});
