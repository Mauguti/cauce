import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Message, RegistroConsumo, Tenant } from "@cauce/core";
import { crearApp } from "../app.ts";
import { hashApiKey } from "../auth.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { Agente } from "./agente.ts";
import { ErrorProveedor, type ProveedorModelo } from "./proveedor.ts";

const KEY = "k".repeat(32);
const TENANT: Tenant = {
  id: "t1", nombre: "Digsol", plan: "pro", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-05T00:00:00Z",
  agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5", esfuerzo: "low", herramientas: [{ nombre: "consultar_agenda", descripcion: "x", url: "https://n8n/x" }] },
};

function registro(over: Partial<RegistroConsumo>): RegistroConsumo {
  return {
    id: crypto.randomUUID(), tenantId: "t1", agente: "Santiago", instanceId: "i1", telefono: "+521••••5347", proveedor: "anthropic",
    modelo: "claude-opus-5", entrada: 1000, salida: 100, cacheLectura: 900, cacheEscritura: 0, costoUsd: 0.01, ms: 800, resultado: "ok", error: null,
    en: "2026-09-14T10:00:00Z", ...over,
  };
}

function levantar(tenant: Tenant = TENANT) {
  const repo = new RepositorioEnMemoria({
    tenants: [tenant],
    instances: [{ id: "i1", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000001", nombre: "Ventas Norte", estado: "connected", ultimoHeartbeat: null }],
  });
  const server = crearApp(repo, undefined, { tipoCambio: { usdMxn: 20, colchon: 1.1 } }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { repo, base, cerrar: () => server.close() };
}
const conKey = { headers: { "x-api-key": KEY } };
afterEach(() => usarSalida(null));

describe("medidor · lectura", () => {
  it("GET /agentes: el agente configurado, su modelo, estado y las líneas que atiende", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/api/tenants/t1/agentes`, conKey);
      expect(res.status).toBe(200);
      const [a] = await res.json();
      expect(a).toMatchObject({ nombre: "Santiago", modelo: "claude-opus-5", esfuerzo: "low", activo: true, enPausaPorPlan: false });
      expect(a.herramientas).toEqual(["pasar_a_humano", "buscar_prospecto", "calificar_prospecto", "consultar_agenda"]);
      expect(a.lineas).toEqual([expect.objectContaining({ instanceId: "i1", nombre: "Ventas Norte", numero: "+5214420000001", estado: "connected" })]);
    } finally { cerrar(); }
  });

  it("GET /agentes: sin agente configurado, lista vacía; con plan sin agentes, enPausaPorPlan", async () => {
    const sin = levantar({ ...TENANT, agente: null });
    try { expect(await (await fetch(`${sin.base}/api/tenants/t1/agentes`, conKey)).json()).toEqual([]); } finally { sin.cerrar(); }
    const est = levantar({ ...TENANT, plan: "estandar" });
    try { expect((await (await fetch(`${est.base}/api/tenants/t1/agentes`, conKey)).json())[0].enPausaPorPlan).toBe(true); } finally { est.cerrar(); }
  });

  it("GET /consumo: suma el mes por agente en USD y en pesos con colchón, cuenta conversaciones distintas y errores; otro mes queda fuera", async () => {
    const { repo, base, cerrar } = levantar();
    try {
      await repo.registrarConsumo(registro({ costoUsd: 0.01, telefono: "+521••••5347" }));
      await repo.registrarConsumo(registro({ costoUsd: 0.02, telefono: "+521••••5347", herramientas: ["pasar_a_humano"] }));
      await repo.registrarConsumo(registro({ costoUsd: 0.005, telefono: "+521••••0002", resultado: "error", error: "529", entrada: 300, salida: 0 }));
      await repo.registrarConsumo(registro({ costoUsd: 9, en: "2026-08-30T10:00:00Z" })); // otro mes
      const res = await fetch(`${base}/api/tenants/t1/consumo?mes=2026-09`, conKey);
      expect(res.status).toBe(200);
      const c = await res.json();
      expect(c.mes).toBe("2026-09");
      expect(c.tipoCambio).toEqual({ usdMxn: 20, colchon: 1.1, efectivo: 22 });
      expect(c.total).toMatchObject({ llamadas: 3, errores: 1, conversaciones: 2, herramientas: 1, costoUsd: 0.035, costoMxn: 0.77 });
      expect(c.porAgente).toHaveLength(1);
      expect(c.porAgente[0]).toMatchObject({ agente: "Santiago", modelos: ["claude-opus-5"], llamadas: 3, costoMxn: 0.77, ultimaEn: "2026-09-14T10:00:00Z" });
      // mes inválido → mes actual
      const actual = await (await fetch(`${base}/api/tenants/t1/consumo?mes=nope`, conKey)).json();
      expect(actual.mes).toBe(new Date().toISOString().slice(0, 7));
    } finally { cerrar(); }
  });
});

describe("contabilidad · rondas de herramientas", () => {
  it("si el proveedor falla en una ronda posterior, el gasto de las rondas anteriores se registra igual", async () => {
    const repo = new RepositorioEnMemoria({ tenants: [TENANT], instances: [{ id: "i1", tenantId: "t1", transportType: "mock", contenedorId: null, numero: null, estado: "connected", ultimoHeartbeat: null }] });
    const p: ProveedorModelo = {
      nombre: "anthropic",
      async responder() {
        throw new ErrorProveedor(new Error("529 overloaded"), { entrada: 2500, salida: 60, cacheLectura: 2000, cacheEscritura: 0 }, "claude-opus-5", 1);
      },
    };
    const agente = new Agente({ repo, proveedores: { anthropic: p } });
    usarSalida(() => {});
    const m: Message = { id: "x", tenantId: "t1", instanceId: "i1", direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: new Date().toISOString() };
    expect((await agente.responder("t1", "i1", m)).texto).toBeNull();
    const [c] = repo.listConsumos("t1");
    expect(c).toMatchObject({ resultado: "error", error: "529 overloaded", entrada: 2500, salida: 60, cacheLectura: 2000 });
    // 2500×5 + 2000×0.5 + 60×25 = 12500 + 1000 + 1500 = 15000 / 1e6
    expect(c!.costoUsd).toBeCloseTo(0.015, 6);
  });
});
