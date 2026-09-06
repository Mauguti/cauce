import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { QrPayload } from "@cauce/transports";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { RepositorioEnMemoria } from "./store.ts";
import type { GestorSesiones } from "./sesiones.ts";

const KEY_A = "key-tenant-a-0000000000000000";
const KEY_B = "key-tenant-b-1111111111111111";

function levantar() {
  const repo = new RepositorioEnMemoria({
    tenants: [
      { id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY_A), creadoEn: "2026-09-05T00:00:00Z" },
      { id: "b", nombre: "B", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY_B), creadoEn: "2026-09-05T00:00:00Z" },
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

  it("/health expone la versión desplegada (para detectar desfase)", async () => {
    const repo = new RepositorioEnMemoria({ tenants: [] });
    const server = crearApp(repo, undefined, { version: "abc1234" }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/health`);
      expect(await res.json()).toEqual({ ok: true, version: "abc1234" });
    } finally {
      server.close();
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

describe("GET /instances/:id/qr", () => {
  function levantarConQr(qr: QrPayload | null) {
    const repo = new RepositorioEnMemoria({
      tenants: [
        { id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY_A), creadoEn: "2026-09-05T00:00:00Z" },
      ],
      instances: [
        { id: "i1", tenantId: "a", transportType: "evolution", contenedorId: "c1", numero: null, estado: "qr", ultimoHeartbeat: null },
      ],
    });
    const gestor = {
      obtener: (id: string) =>
        id === "i1"
          ? { transport: { getQr: async () => qr }, contenedorId: "c1", baseUrl: "", webhookToken: "t" }
          : null,
    } as unknown as GestorSesiones;
    const server = crearApp(repo, gestor).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, cerrar: () => server.close() };
  }

  it("devuelve el QR con 200 cuando hay", async () => {
    const { base, cerrar } = levantarConQr({ codigo: "2@abc", imagenBase64: "data:img" });
    try {
      const res = await fetch(`${base}/api/tenants/a/instances/i1/qr`, conKey(KEY_A));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ codigo: "2@abc", imagenBase64: "data:img" });
    } finally {
      cerrar();
    }
  });

  it("responde 200 con QR nulo (no 404) cuando no hay QR en este estado", async () => {
    const { base, cerrar } = levantarConQr(null);
    try {
      const res = await fetch(`${base}/api/tenants/a/instances/i1/qr`, conKey(KEY_A));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ codigo: null, imagenBase64: null });
    } finally {
      cerrar();
    }
  });

  it("404 solo para instancia inexistente", async () => {
    const { base, cerrar } = levantarConQr(null);
    try {
      const res = await fetch(`${base}/api/tenants/a/instances/nope/qr`, conKey(KEY_A));
      expect(res.status).toBe(404);
    } finally {
      cerrar();
    }
  });
});

describe("autenticación con ID token de Firebase", () => {
  // Verificador falso: el uid es el primer segmento del "jwt".
  const verificar = async (t: string) => ({
    uid: t.split(".")[0]!,
    email: null,
    nombre: null,
  });

  function levantarFirebase() {
    const repo = new RepositorioEnMemoria({
      tenants: [
        { id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: "z".repeat(64), creadoEn: "2026-09-05T00:00:00Z" },
      ],
    });
    // Asocia uid-ana → tenant a (como haría el provisioning).
    void repo.provisionarTenant("uid-ana", () => ({
      id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: "z".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
    }));
    const server = crearApp(repo, undefined, { verificarToken: verificar }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, cerrar: () => server.close() };
  }

  it("resuelve el tenant del uid del token", async () => {
    const { base, cerrar } = levantarFirebase();
    try {
      // "jwt" de 3 segmentos: el verificador falso toma "uid-ana".
      const res = await fetch(`${base}/api/me`, {
        headers: { authorization: `Bearer uid-ana.x.y` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).tenantId).toBe("a");
    } finally {
      cerrar();
    }
  });

  it("token de un uid sin tenant → 401", async () => {
    const { base, cerrar } = levantarFirebase();
    try {
      const res = await fetch(`${base}/api/me`, {
        headers: { authorization: `Bearer uid-desconocido.x.y` },
      });
      expect(res.status).toBe(401);
    } finally {
      cerrar();
    }
  });
});
