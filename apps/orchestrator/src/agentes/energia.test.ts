import { describe, expect, it } from "vitest";
import type { FotoPrecios, RegistroConsumo, Tenant } from "@cauce/core";
import {
  calcularBolsa,
  descontarCreditos,
  ENERGIA_MULTIPLICADOR_DEFAULT,
  estadoEnergia,
  gastoMesMxn,
  MENSAJE_ENERGIA_AGOTADA,
  UMBRAL_AVISO,
} from "./energia.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { hashApiKey } from "../auth.ts";
import { usarSalida } from "../log.ts";

const KEY = "k".repeat(32);
const PRECIOS: FotoPrecios = {
  version: "test",
  IVA: 0.16,
  PRECIO_PLAN: { basico: 599, estandar: 1199, pro: 2200 },
  LINEAS_INCLUIDAS: 1,
  LINEA_ADICIONAL: { precioHasta4: 499, precioDesde5: 429, umbral: 5 },
  AGENTE: { incluidosEnPro: 1, bolsaApiMensual: 200, adicional: 550 },
  PERIODOS: {
    mensual: { nombre: "Mensual", meses: 1, descuento: 0 },
    semestral: { nombre: "Semestral", meses: 6, descuento: 0.1 },
    anual: { nombre: "Anual", meses: 12, descuento: 0.25 },
  },
};
const TC = { usdMxn: 20, colchon: 1.1 };

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1", nombre: "Test", plan: "pro", estado: "activo",
    apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-01T00:00:00Z", ...over,
  };
}

function consumo(costoUsd: number, en = "2026-09-15T10:00:00Z"): RegistroConsumo {
  return {
    id: crypto.randomUUID(), tenantId: "t1", agente: "Santiago", instanceId: "i1",
    telefono: "+521••••0001", proveedor: "anthropic", modelo: "claude-opus-5",
    entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0,
    costoUsd, ms: 500, resultado: "ok", error: null, en,
  };
}

describe("calcularBolsa", () => {
  it("$200 por agente contratado, mínimo 1", () => {
    expect(calcularBolsa(PRECIOS, 1)).toBe(200);
    expect(calcularBolsa(PRECIOS, 3)).toBe(600);
    expect(calcularBolsa(PRECIOS, 0)).toBe(200); // mínimo 1
  });
});

describe("gastoMesMxn", () => {
  it("suma USD × tipo de cambio efectivo y redondea a centavos", () => {
    const c = [consumo(0.01), consumo(0.02), consumo(0.005)];
    // 0.035 USD × 20 × 1.1 = 0.035 × 22 = 0.77
    expect(gastoMesMxn(c, TC)).toBe(0.77);
  });

  it("sin consumos, cero", () => {
    expect(gastoMesMxn([], TC)).toBe(0);
  });
});

describe("estadoEnergia", () => {
  it("dentro de la bolsa: sin créditos gastados", () => {
    const e = estadoEnergia(200, 0, 50);
    expect(e.bolsaUsada).toBe(50);
    expect(e.bolsaRestante).toBe(150);
    expect(e.excesoCreditos).toBe(0);
    expect(e.creditosRestantes).toBe(0);
    expect(e.disponible).toBe(150);
    expect(e.porcentajeBolsa).toBe(0.25);
    expect(e.agotada).toBe(false);
  });

  it("bolsa excedida con créditos: créditos se consumen", () => {
    const e = estadoEnergia(200, 100, 250);
    expect(e.bolsaUsada).toBe(200);
    expect(e.bolsaRestante).toBe(0);
    expect(e.excesoCreditos).toBe(50);
    expect(e.creditosRestantes).toBe(50);
    expect(e.disponible).toBe(50);
    expect(e.porcentajeBolsa).toBe(1);
    expect(e.agotada).toBe(false);
  });

  it("agotada: bolsa y créditos consumidos", () => {
    const e = estadoEnergia(200, 50, 260);
    expect(e.agotada).toBe(true);
    expect(e.disponible).toBe(0);
    expect(e.excesoCreditos).toBe(60);
    expect(e.creditosRestantes).toBe(0);
  });

  it("multiplicador amplifica créditos", () => {
    const e = estadoEnergia(200, 100, 300, 1.5);
    // creditosDisponibles = 100 × 1.5 = 150
    // exceso = 300 - 200 = 100
    // creditosRestantes = 150 - 100 = 50
    expect(e.creditosDisponibles).toBe(150);
    expect(e.creditosRestantes).toBe(50);
    expect(e.agotada).toBe(false);
  });

  it("umbral de aviso al 80%", () => {
    const al79 = estadoEnergia(200, 0, 158);
    expect(al79.porcentajeBolsa).toBe(0.79);

    const al80 = estadoEnergia(200, 0, 160);
    expect(al80.porcentajeBolsa).toBe(0.80);
    expect(al80.porcentajeBolsa).toBeGreaterThanOrEqual(UMBRAL_AVISO);
  });
});

describe("descontarCreditos", () => {
  it("descuenta el exceso de los créditos del tenant", async () => {
    usarSalida(() => {});
    const t = tenant({ creditosMxn: 100 });
    const repo = new RepositorioEnMemoria({ tenants: [t] });
    const restante = await descontarCreditos(repo, "t1", 30, 0);
    expect(restante).toBe(70);
    const actualizado = await repo.getTenant("t1");
    expect(actualizado!.creditosMxn).toBe(70);
    usarSalida(null);
  });

  it("no pone créditos negativos", async () => {
    usarSalida(() => {});
    const t = tenant({ creditosMxn: 10 });
    const repo = new RepositorioEnMemoria({ tenants: [t] });
    const restante = await descontarCreditos(repo, "t1", 50, 0);
    expect(restante).toBe(0);
    usarSalida(null);
  });

  it("no toca créditos si la bolsa alcanza", async () => {
    usarSalida(() => {});
    const t = tenant({ creditosMxn: 100 });
    const repo = new RepositorioEnMemoria({ tenants: [t] });
    // costoMxn=30, bolsaRestanteAntes=50 → exceso=0, no se tocan créditos
    const restante = await descontarCreditos(repo, "t1", 30, 50);
    expect(restante).toBe(-1); // sentinel: no se tocaron
    const actualizado = await repo.getTenant("t1");
    expect(actualizado!.creditosMxn).toBe(100); // intactos
    usarSalida(null);
  });
});

describe("mensaje de degradación", () => {
  it("no deja al contacto en el vacío", () => {
    expect(MENSAJE_ENERGIA_AGOTADA).toContain("equipo");
    expect(MENSAJE_ENERGIA_AGOTADA).toContain("contactará");
    expect(MENSAJE_ENERGIA_AGOTADA.length).toBeGreaterThan(20);
  });
});
