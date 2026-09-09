import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { QrPayload } from "@cauce/transports";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { RepositorioEnMemoria } from "./store.ts";
import { SesionNoCerrada, type GestorSesiones } from "./sesiones.ts";

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

describe("DELETE /instances/:id (logout confirmado antes de destruir)", () => {
  const KEY = "key-del-00000000000000000000000000";
  function levantar(fakeEliminar: GestorSesiones["eliminar"]) {
    const repo = new RepositorioEnMemoria({
      tenants: [{ id: "t", nombre: "T", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-06T00:00:00Z" }],
      instances: [{ id: "i1", tenantId: "t", transportType: "evolution", contenedorId: "c", numero: null, estado: "connected", ultimoHeartbeat: null }],
    });
    const gestor = { eliminar: fakeEliminar } as unknown as GestorSesiones;
    const server = crearApp(repo, gestor).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, repo, cerrar: () => server.close() };
  }
  const h = { method: "DELETE", headers: { "x-api-key": KEY } };

  it("si el logout no se confirma → 409, mensaje accionable y NO borra", async () => {
    const { base, repo, cerrar } = levantar(async () => {
      throw new SesionNoCerrada("i1");
    });
    try {
      const res = await fetch(`${base}/api/tenants/t/instances/i1`, h);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Dispositivos vinculados/);
      // La instancia sigue viva: no se borró en silencio.
      expect(await repo.getInstance("t", "i1")).not.toBeNull();
    } finally {
      cerrar();
    }
  });

  it("logout confirmado → 204", async () => {
    const { base, repo, cerrar } = levantar(async (tenantId, instanceId) => {
      await repo.deleteInstance(tenantId, instanceId);
    });
    try {
      const res = await fetch(`${base}/api/tenants/t/instances/i1`, h);
      expect(res.status).toBe(204);
      expect(await repo.getInstance("t", "i1")).toBeNull();
    } finally {
      cerrar();
    }
  });
});

describe("POST /messages/:id/retry (reintento manual)", () => {
  const KEY = "key-retry-0000000000000000000000";
  function levantar(msg: any, sesionActiva = true) {
    const repo = new RepositorioEnMemoria({
      tenants: [{ id: "t", nombre: "T", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-06T00:00:00Z" }],
      instances: [{ id: "i1", tenantId: "t", transportType: "evolution", contenedorId: "c", numero: null, estado: "connected", ultimoHeartbeat: null }],
    });
    void repo.saveMessage(msg);
    const encolados: any[] = [];
    const gestor = { obtener: (id: string) => (sesionActiva && id === "i1" ? {} : null) } as unknown as GestorSesiones;
    const cola = { encolar: async (m: any) => encolados.push(m) } as any;
    const server = crearApp(repo, gestor, { cola }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, encolados, repo, cerrar: () => server.close() };
  }
  const msgFallido = (over: any = {}) => ({
    id: "m1", tenantId: "t", instanceId: "i1", direccion: "out",
    telefono: "+525512345678", cuerpo: "hola", estado: "fallido",
    externalId: null, error: "x", errorCodigo: "sesion_desconectada",
    timestamp: "2026-09-06T00:00:00Z", ...over,
  });
  const h = { headers: { "x-api-key": KEY } };

  it("re-encola un fallido reintentable", async () => {
    const { base, encolados, cerrar } = levantar(msgFallido());
    try {
      const res = await fetch(`${base}/api/tenants/t/messages/m1/retry`, { method: "POST", ...h });
      expect(res.status).toBe(202);
      expect(encolados[0]).toMatchObject({ id: "m1", estado: "encolado", error: null });
    } finally { cerrar(); }
  });

  it("rechaza un fallo no reintentable (409)", async () => {
    const { base, cerrar } = levantar(msgFallido({ errorCodigo: "telefono_vacio" }));
    try {
      const res = await fetch(`${base}/api/tenants/t/messages/m1/retry`, { method: "POST", ...h });
      expect(res.status).toBe(409);
    } finally { cerrar(); }
  });

  it("409 si la sesión no está activa", async () => {
    const { base, cerrar } = levantar(msgFallido(), false);
    try {
      const res = await fetch(`${base}/api/tenants/t/messages/m1/retry`, { method: "POST", ...h });
      expect(res.status).toBe(409);
    } finally { cerrar(); }
  });
});

describe("límite de conectores del plan (simétrico monday ↔ bitrix)", () => {
  // Dobles mínimos: solo verConfig y guardarAlta, que es lo que consultan los guards.
  function levantarConCrm(conectados: { monday: boolean; bitrix: boolean }) {
    const repo = new RepositorioEnMemoria({
      tenants: [
        { id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: hashApiKey(KEY_A), creadoEn: "2026-09-05T00:00:00Z" },
      ],
      instances: [
        { id: "i1", tenantId: "a", transportType: "mock", contenedorId: null, numero: "+521", estado: "connected", ultimoHeartbeat: null },
      ],
    });
    const altas: string[] = [];
    const monday = {
      verConfig: async () => (conectados.monday ? { instanceId: "i1" } : null),
      guardarAlta: async () => { altas.push("monday"); },
    };
    const bitrix = {
      verConfig: async () => (conectados.bitrix ? { instanceId: "i1" } : null),
      guardarAlta: async () => { altas.push("bitrix"); },
    };
    const server = crearApp(repo, undefined, { monday: monday as any, bitrix: bitrix as any }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, altas, cerrar: () => server.close() };
  }
  const put = (base: string, crm: "monday" | "bitrix", body: unknown) =>
    fetch(`${base}/api/tenants/a/conectores/${crm}`, {
      method: "PUT",
      headers: { "x-api-key": KEY_A, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const altaMonday = { instanceId: "i1", boardId: "b1", columnaTelefono: "phone", apiToken: "tok" };
  const altaBitrix = { instanceId: "i1", entidad: "deal", campoTelefono: "PHONE", webhookUrl: "https://p.bitrix24.mx/rest/1/x/" };

  it("con Bitrix conectado y plan de 1 conector, dar de alta monday → 403 (antes pasaba)", async () => {
    const { base, altas, cerrar } = levantarConCrm({ monday: false, bitrix: true });
    try {
      const res = await put(base, "monday", altaMonday);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Tu plan permite 1 conector. Contrata más para agregar otro.");
      expect(altas).toEqual([]);
    } finally {
      cerrar();
    }
  });

  it("con monday conectado, dar de alta Bitrix → 403 (ya era así)", async () => {
    const { base, altas, cerrar } = levantarConCrm({ monday: true, bitrix: false });
    try {
      const res = await put(base, "bitrix", altaBitrix);
      expect(res.status).toBe(403);
      expect(altas).toEqual([]);
    } finally {
      cerrar();
    }
  });

  it("sin conectores, el primero de cualquiera se acepta; editar el existente no cuenta", async () => {
    const libre = levantarConCrm({ monday: false, bitrix: false });
    try {
      expect((await put(libre.base, "monday", altaMonday)).status).toBe(204);
      expect(libre.altas).toEqual(["monday"]);
    } finally {
      libre.cerrar();
    }
    const editar = levantarConCrm({ monday: true, bitrix: false });
    try {
      expect((await put(editar.base, "monday", { ...altaMonday, apiToken: "" })).status).toBe(204);
      expect(editar.altas).toEqual(["monday"]);
    } finally {
      editar.cerrar();
    }
  });
});
