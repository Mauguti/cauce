import { describe, expect, it } from "vitest";
import {
  capacidadesTenant, esSubida, limitesTenant, mensajeRequierePlan, normalizarPlan,
  planDe, planQueHabilita, pruebaVigente, soloLectura, tieneCapacidad, type Tenant,
} from "./index.ts";

const t = (over: Partial<Tenant>): Tenant => ({
  id: "t", nombre: "T", plan: "basico", estado: "activo", apiKeyHash: "x", creadoEn: "2026-09-01T00:00:00Z", ...over,
});

describe("modelo de planes", () => {
  it("cada plan vendido tiene sus capacidades", () => {
    expect(capacidadesTenant(t({ plan: "basico" }))).toEqual(["salientes"]);
    expect(capacidadesTenant(t({ plan: "estandar" }))).toEqual(["salientes", "entrantes", "bots"]);
    expect(capacidadesTenant(t({ plan: "pro" }))).toEqual(["salientes", "entrantes", "bots", "agentes"]);
  });

  it("la prueba tiene lo de Estándar sin agentes, y al vencer cae a solo lectura", () => {
    const vigente = t({ plan: "prueba", pruebaExpiraEn: "2099-01-01T00:00:00Z" });
    expect(capacidadesTenant(vigente)).toEqual(["salientes", "entrantes", "bots"]);
    expect(tieneCapacidad(vigente, "agentes")).toBe(false);
    const vencida = t({ plan: "prueba", pruebaExpiraEn: "2020-01-01T00:00:00Z" });
    expect(pruebaVigente(vencida)).toBe(false);
    expect(soloLectura(vencida)).toBe(true);
    expect(capacidadesTenant(vencida)).toEqual([]);
  });

  it("los ids legado se leen como Estándar sin migrar (base, extras)", () => {
    expect(normalizarPlan("base")).toBe("estandar");
    expect(normalizarPlan("extras")).toBe("estandar");
    expect(normalizarPlan("basico")).toBe("basico");
    const legado = t({ plan: "base" as Tenant["plan"] });
    expect(planDe(legado).nombre).toBe("Estándar");
    expect(tieneCapacidad(legado, "bots")).toBe(true); // Procesa y We Build no pierden nada
    expect(pruebaVigente(legado)).toBe(true);
  });

  it("un id desconocido no revienta: cae a Básico y se conserva para registrarlo", () => {
    expect(normalizarPlan("misterio")).toBe("misterio");
    expect(planDe(t({ plan: "misterio" as Tenant["plan"] })).nombre).toBe("Básico");
  });

  it("los límites vienen del plan, el override manda, y los campos deprecados aún se leen", () => {
    expect(limitesTenant(t({ plan: "estandar" }))).toEqual({ lineas: 1, conectores: 1, agentes: 0 });
    expect(limitesTenant(t({ plan: "estandar", limitesOverride: { lineas: 99, conectores: 99 } })))
      .toEqual({ lineas: 99, conectores: 99, agentes: 0 });
    expect(limitesTenant(t({ plan: "estandar", limiteLineas: 3 })).lineas).toBe(3);
    expect(limitesTenant(t({ plan: "estandar", limiteLineas: 3, limitesOverride: { lineas: 5 } })).lineas).toBe(5);
    expect(limitesTenant(t({ plan: "pro" })).agentes).toBe(1);
  });

  it("dice qué plan habilita cada capacidad, con el mensaje literal del 403", () => {
    expect(planQueHabilita("salientes")).toBe("basico");
    expect(planQueHabilita("bots")).toBe("estandar");
    expect(planQueHabilita("agentes")).toBe("pro");
    expect(mensajeRequierePlan("bots")).toBe("Los flujos de bots vienen en el plan Estándar.");
    expect(mensajeRequierePlan("agentes")).toBe("Los agentes de IA vienen en el plan Pro.");
  });

  it("distingue subida de bajada", () => {
    expect(esSubida("basico", "estandar")).toBe(true);
    expect(esSubida("pro", "estandar")).toBe(false);
    expect(esSubida("prueba", "basico")).toBe(true);
  });
});
