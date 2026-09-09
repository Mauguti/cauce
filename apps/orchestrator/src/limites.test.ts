import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  churnReciente,
  registrarCreacionSesion,
  SESIONES_RECIENTES_MAX,
  type Instance,
  type Tenant,
} from "@cauce/core";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { RepositorioEnMemoria } from "./store.ts";
import type { GestorSesiones } from "./sesiones.ts";

const KEY = "key-limites-000000000000000000";

function tenant(over: Partial<Tenant>): Tenant {
  return {
    id: "t1",
    nombre: "T",
    plan: "prueba",
    estado: "activo",
    apiKeyHash: hashApiKey(KEY),
    creadoEn: "2026-09-06T00:00:00Z",
    ...over,
  };
}

function instancia(id: string): Instance {
  return {
    id,
    tenantId: "t1",
    transportType: "evolution",
    contenedorId: "c",
    numero: null,
    estado: "connected",
    ultimoHeartbeat: null,
  };
}

function levantar(t: Tenant, instancias: Instance[] = []) {
  const repo = new RepositorioEnMemoria({ tenants: [t], instances: instancias });
  // Gestor que "crea" sin Docker.
  let creadas = 0;
  const gestor = {
    crear: async () => {
      creadas += 1;
      const inst = instancia(`nueva-${creadas}`);
      await repo.saveInstance(inst);
      return inst;
    },
  } as unknown as GestorSesiones;
  const server = crearApp(repo, gestor).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, cerrar: () => server.close() };
}

const conKey = { headers: { "x-api-key": KEY, "content-type": "application/json" } };

describe("límites por plan al crear sesión", () => {
  it("permite crear hasta el límite del plan (prueba: 1 línea)", async () => {
    const { base, cerrar } = levantar(tenant({}));
    try {
      const r1 = await fetch(`${base}/api/tenants/t1/instances`, { method: "POST", ...conKey });
      expect(r1.status).toBe(201);
      const r2 = await fetch(`${base}/api/tenants/t1/instances`, { method: "POST", ...conKey });
      expect(r2.status).toBe(403);
      expect((await r2.json()).error).toMatch(/1 línea/);
    } finally {
      cerrar();
    }
  });

  it("plan extras respeta el límite contratado", async () => {
    const { base, cerrar } = levantar(tenant({ plan: "estandar", limitesOverride: { lineas: 3 } }));
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${base}/api/tenants/t1/instances`, { method: "POST", ...conKey });
        expect(r.status).toBe(201);
      }
      const cuarta = await fetch(`${base}/api/tenants/t1/instances`, { method: "POST", ...conKey });
      expect(cuarta.status).toBe(403);
      expect((await cuarta.json()).error).toMatch(/3 líneas/);
    } finally {
      cerrar();
    }
  });

  it("prueba vencida: no deja crear sesión y lo dice claro", async () => {
    const ayer = new Date(Date.now() - 86_400_000).toISOString();
    const { base, cerrar } = levantar(tenant({ plan: "prueba", pruebaExpiraEn: ayer }));
    try {
      const r = await fetch(`${base}/api/tenants/t1/instances`, { method: "POST", ...conKey });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/prueba terminó/i);
    } finally {
      cerrar();
    }
  });

  it("/api/me expone plan, límites y vigencia de la prueba", async () => {
    const manana = new Date(Date.now() + 86_400_000).toISOString();
    const { base, cerrar } = levantar(tenant({ plan: "prueba", pruebaExpiraEn: manana }));
    try {
      const r = await fetch(`${base}/api/me`, conKey);
      const yo = await r.json();
      expect(yo).toMatchObject({ plan: "prueba", pruebaVigente: true, terminosAceptados: false });
      expect(yo.limites).toEqual({ lineas: 1, conectores: 1, agentes: 0 });
      expect(yo.capacidades).toEqual(["salientes", "entrantes", "bots"]);
    } finally {
      cerrar();
    }
  });

  it("aceptar-terminos marca la aceptación (idempotente) y /api/me lo refleja", async () => {
    const repo = new RepositorioEnMemoria({ tenants: [tenant({ plan: "prueba" })] });
    const server = crearApp(repo).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = await fetch(`${base}/api/tenants/t1/onboarding/aceptar-terminos`, {
        method: "POST", ...conKey,
      });
      expect(post.status).toBe(204);
      const yo = await (await fetch(`${base}/api/me`, conKey)).json();
      expect(yo.terminosAceptados).toBe(true);
      const t1 = await repo.getTenant("t1");
      const primeraFecha = t1!.terminosAceptadosEn;
      // Segunda vez: no cambia la fecha.
      await fetch(`${base}/api/tenants/t1/onboarding/aceptar-terminos`, { method: "POST", ...conKey });
      expect((await repo.getTenant("t1"))!.terminosAceptadosEn).toBe(primeraFecha);
    } finally {
      server.close();
    }
  });
});

describe("churn de sesiones", () => {
  it("marca churn con >= 3 creaciones dentro de la ventana (el patrón real)", () => {
    const ahora = new Date("2026-09-06T12:00:00Z");
    // Crear/borrar el mismo número en ráfaga: tres creaciones en ~4 min.
    const t = tenant({
      sesionesRecientes: [
        "2026-09-06T11:56:00Z",
        "2026-09-06T11:58:00Z",
        "2026-09-06T11:59:30Z",
      ],
    });
    expect(churnReciente(t, ahora)).toBe(true);
  });

  it("no marca churn con creaciones espaciadas fuera de la ventana", () => {
    const ahora = new Date("2026-09-06T12:00:00Z");
    const t = tenant({
      sesionesRecientes: [
        "2026-09-06T10:00:00Z", // hace 2 h
        "2026-09-06T11:00:00Z", // hace 1 h
        "2026-09-06T11:59:00Z", // reciente, pero solo una en la ventana
      ],
    });
    expect(churnReciente(t, ahora)).toBe(false);
  });

  it("registrarCreacionSesion agrega y acota el buffer", () => {
    let t = tenant({});
    for (let i = 0; i < SESIONES_RECIENTES_MAX + 5; i++) {
      t = { ...t, sesionesRecientes: registrarCreacionSesion(t) };
    }
    expect(t.sesionesRecientes).toHaveLength(SESIONES_RECIENTES_MAX);
  });

  it("/api/me expone churnReciente del tenant", async () => {
    const ahora = Date.now();
    const recientes = [ahora - 60_000, ahora - 120_000, ahora - 180_000].map(
      (ms) => new Date(ms).toISOString(),
    );
    const { base, cerrar } = levantar(tenant({ sesionesRecientes: recientes }));
    try {
      const yo = await (await fetch(`${base}/api/me`, conKey)).json();
      expect(yo.churnReciente).toBe(true);
    } finally {
      cerrar();
    }
  });
});

describe("cambio de plan (admin)", () => {
  it("sube de prueba a base y limpia la caducidad; exige admin key", async () => {
    const ayer = new Date(Date.now() - 86_400_000).toISOString();
    const repo = new RepositorioEnMemoria({
      tenants: [tenant({ plan: "prueba", pruebaExpiraEn: ayer })],
    });
    const server = crearApp(repo, undefined, { adminKey: "secreto-admin" }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sinKey = await fetch(`${base}/api/admin/tenants/t1/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "estandar" }),
      });
      expect(sinKey.status).toBe(401);

      const ok = await fetch(`${base}/api/admin/tenants/t1/plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "secreto-admin" },
        body: JSON.stringify({ plan: "estandar" }),
      });
      expect(ok.status).toBe(200);
      const t = await repo.getTenant("t1");
      expect(t!.plan).toBe("estandar");
      expect(t!.pruebaExpiraEn).toBeNull();
    } finally {
      server.close();
    }
  });
});
