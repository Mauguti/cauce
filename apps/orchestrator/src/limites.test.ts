import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Instance, Tenant } from "@cauce/core";
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
    const { base, cerrar } = levantar(tenant({ plan: "extras", limiteLineas: 3 }));
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
      expect(yo).toMatchObject({ plan: "prueba", pruebaVigente: true });
      expect(yo.limites).toEqual({ lineas: 1, conectores: 1 });
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
        body: JSON.stringify({ plan: "base" }),
      });
      expect(sinKey.status).toBe(401);

      const ok = await fetch(`${base}/api/admin/tenants/t1/plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "secreto-admin" },
        body: JSON.stringify({ plan: "base" }),
      });
      expect(ok.status).toBe(200);
      const t = await repo.getTenant("t1");
      expect(t!.plan).toBe("base");
      expect(t!.pruebaExpiraEn).toBeNull();
    } finally {
      server.close();
    }
  });
});
