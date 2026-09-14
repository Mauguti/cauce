import { afterEach, describe, expect, it } from "vitest";
import type { Message, Tenant } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { MotorEntrada } from "../entrada/motor.ts";
import { Agente, armarSistema, CATALOGO_MAX_CARACTERES } from "./agente.ts";
import { costoUsd, type PeticionModelo, type ProveedorModelo } from "./proveedor.ts";

const TENANT: Tenant = {
  id: "t1", nombre: "Digsol Factory", plan: "pro", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
  agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5", esfuerzo: "low", maxSalida: 400 },
};

const entrante = (cuerpo: string, id: string = crypto.randomUUID(), ts = new Date().toISOString()): Message =>
  ({ id, tenantId: "t1", instanceId: "i1", direccion: "in", telefono: "+5214428575347", cuerpo, estado: "recibido", externalId: null, timestamp: ts });

function proveedorFalso(respuesta: string | null = "Con gusto: Digsol Factory conecta tu WhatsApp con tu CRM.", opciones: { falla?: boolean; rechazo?: boolean } = {}) {
  const peticiones: PeticionModelo[] = [];
  const p: ProveedorModelo = {
    nombre: "anthropic",
    async responder(pet) {
      peticiones.push(pet);
      if (opciones.falla) throw new Error("529 overloaded");
      return {
        texto: opciones.rechazo ? null : respuesta,
        modelo: pet.modelo,
        uso: { entrada: 1200, salida: 80, cacheLectura: 1000, cacheEscritura: 0 },
        costoUsd: costoUsd(pet.modelo, { entrada: 1200, salida: 80, cacheLectura: 1000, cacheEscritura: 0 }),
        parada: opciones.rechazo ? "refusal" : "end_turn",
      };
    },
  };
  return { p, peticiones };
}

function armar(tenant: Tenant = TENANT, prov = proveedorFalso()) {
  const repo = new RepositorioEnMemoria({
    tenants: [tenant],
    instances: [{ id: "i1", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000001", estado: "connected", ultimoHeartbeat: null }],
  });
  const agente = new Agente({ repo, proveedores: { anthropic: prov.p } });
  return { repo, agente, ...prov };
}

function capturarBitacora() {
  const lineas: string[] = [];
  usarSalida((_n, l) => { lineas.push(l); });
  return lineas;
}
afterEach(() => usarSalida(null));

describe("armarSistema", () => {
  it("manda COMPLETOS los campos cortos del ADN, sin recuperación, y el catálogo mientras quepa", () => {
    const { sistema, catalogoRecortado } = armarSistema(TENANT.agente!, TENANT, {
      pitch: "Conectamos WhatsApp con tu CRM.", buyerPersona: "PyMEs con ventas por WhatsApp", discountPolicy: "Nunca más de 10 %",
      prohibitedTopics: "No hablamos de competidores", toneCasual: true, toneConcise: true, idealPhrases: "¡Con gusto!",
      brandInstructions: "Somos directos.", products: [{ name: "Estándar", description: "Bandeja compartida", price: 1199, currency: "MXN" }],
    });
    expect(sistema).toContain("Eres Santiago, agente de atención de Digsol Factory");
    expect(sistema).toContain("## Radiografía del negocio\nConectamos WhatsApp con tu CRM.");
    expect(sistema).toContain("Nunca más de 10 %");
    expect(sistema).toContain("No hablamos de competidores");
    expect(sistema).toContain("Tono: cercano y casual, sin perder respeto; conciso, sin relleno.");
    expect(sistema).toContain("- Estándar · 1,199 MXN: Bandeja compartida");
    expect(sistema).toContain("No inventes precios");
    expect(catalogoRecortado).toBe(false);
  });

  it("un catálogo enorme se recorta al tope y se avisa en el prompt", () => {
    const products = Array.from({ length: 2000 }, (_, i) => ({ name: `Producto ${i}`, description: "x".repeat(40), price: 10 }));
    const { sistema, catalogoRecortado } = armarSistema(TENANT.agente!, TENANT, { products });
    expect(catalogoRecortado).toBe(true);
    expect(sistema.length).toBeLessThan(CATALOGO_MAX_CARACTERES + 3000);
    expect(sistema).toContain("El catálogo es más largo");
  });
});

describe("Agente", () => {
  it("contesta con el ADN como sistema, el historial de la conversación y registra tokens y costo", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await c.repo.saveConocimiento("t1", { pitch: "Conectamos WhatsApp con tu CRM." });
    // Historial previo: pregunta y respuesta anteriores
    await c.repo.saveMessage(entrante("hola", "m1", "2026-09-14T10:00:00Z"));
    await c.repo.saveMessage({ id: "m2", tenantId: "t1", instanceId: "i1", direccion: "out", telefono: "+5214428575347", cuerpo: "¡Hola! ¿En qué te ayudo?", estado: "enviado", externalId: null, timestamp: "2026-09-14T10:00:05Z" });
    const actual = entrante("¿qué es Digsol Factory?", "m3", "2026-09-14T10:01:00Z");
    await c.repo.saveMessage(actual);

    const texto = await c.agente.responder("t1", "i1", actual, "Mau");
    expect(texto).toContain("Digsol Factory conecta");
    const pet = c.peticiones[0]!;
    expect(pet.modelo).toBe("claude-opus-5");
    expect(pet.esfuerzo).toBe("low");
    expect(pet.sistema).toContain("Conectamos WhatsApp con tu CRM.");
    expect(pet.historial).toEqual([
      { rol: "usuario", texto: "hola" },
      { rol: "asistente", texto: "¡Hola! ¿En qué te ayudo?" },
      { rol: "usuario", texto: "Mau: ¿qué es Digsol Factory?" },
    ]);
    const consumos = c.repo.listConsumos("t1");
    expect(consumos).toHaveLength(1);
    expect(consumos[0]).toMatchObject({ agente: "Santiago", modelo: "claude-opus-5", entrada: 1200, salida: 80, cacheLectura: 1000, resultado: "ok", telefono: "+521••••5347" });
    // 1200×5 + 1000×0.5 + 80×25 = 6000 + 500 + 2000 = 8500 / 1e6
    expect(consumos[0]!.costoUsd).toBeCloseTo(0.0085, 6);
    expect(bitacora.some((l) => l.includes("agente.consumo") && l.includes("costoUsd=0.0085") && l.includes("resultado=ok"))).toBe(true);
  });

  it("sin agente activo no llama al modelo; con proveedor desconocido tampoco y lo dice", async () => {
    const inactivo = armar({ ...TENANT, agente: { ...TENANT.agente!, activo: false } });
    expect(await inactivo.agente.responder("t1", "i1", entrante("hola"))).toBeNull();
    expect(inactivo.peticiones).toHaveLength(0);
    const bitacora = capturarBitacora();
    const otro = armar({ ...TENANT, agente: { ...TENANT.agente!, proveedor: "otro" as any } });
    expect(await otro.agente.responder("t1", "i1", entrante("hola"))).toBeNull();
    expect(bitacora.at(-1)).toMatch(/agente\.sin_proveedor/);
  });

  it("un rechazo del modelo no manda nada y queda registrado; un error del proveedor tampoco lanza y se registra con costo 0", async () => {
    const rechazo = armar(TENANT, proveedorFalso(null, { rechazo: true }));
    expect(await rechazo.agente.responder("t1", "i1", entrante("hola"))).toBeNull();
    expect(rechazo.repo.listConsumos("t1")[0]!.resultado).toBe("rechazo");
    const falla = armar(TENANT, proveedorFalso("x", { falla: true }));
    expect(await falla.agente.responder("t1", "i1", entrante("hola"))).toBeNull();
    expect(falla.repo.listConsumos("t1")[0]).toMatchObject({ resultado: "error", error: "529 overloaded", costoUsd: 0 });
  });
});

describe("MotorEntrada con agente", () => {
  function motorCon(tenant: Tenant) {
    const c = armar(tenant);
    const enviados: string[] = [];
    const motor = new MotorEntrada({ repo: c.repo, agente: c.agente, enviarInmediato: async (_t, _i, _tel, cuerpo) => { enviados.push(cuerpo); } });
    return { ...c, motor, enviados };
  }

  it("con plan Pro y sin disparador que coincida, contesta el agente por el carril inmediato", async () => {
    const c = motorCon(TENANT);
    await c.motor.procesar("t1", "i1", entrante("¿qué incluye el plan Estándar?"), "Mau");
    expect(c.enviados).toHaveLength(1);
    expect(c.peticiones).toHaveLength(1);
  });

  it("un disparador que coincide gana y el agente no gasta", async () => {
    const c = motorCon(TENANT);
    await c.repo.saveDisparadores("t1", [{ id: "hola", prioridad: 1, tipo: "palabra_clave", patron: "hola", coincidencia: "igual", activo: true, respuesta: "¡Hola!" }]);
    await c.motor.procesar("t1", "i1", entrante("hola"));
    expect(c.enviados).toEqual(["¡Hola!"]);
    expect(c.peticiones).toHaveLength(0);
  });

  it("en plan Estándar el agente NO contesta aunque esté configurado: agentes es de Pro", async () => {
    const c = motorCon({ ...TENANT, plan: "estandar" });
    await c.motor.procesar("t1", "i1", entrante("¿qué incluye el plan Estándar?"));
    expect(c.enviados).toHaveLength(0);
    expect(c.peticiones).toHaveLength(0);
  });

  it("en ventana humana el agente calla", async () => {
    const c = motorCon(TENANT);
    await c.repo.registrarEntrante("t1", "i1", "5214428575347", "2026-09-14T10:00:00Z", "Mau");
    await c.repo.marcarHumana("t1", "i1", "5214428575347", new Date(Date.now() + 60_000).toISOString());
    await c.motor.procesar("t1", "i1", entrante("¿sigues ahí?"));
    expect(c.peticiones).toHaveLength(0);
  });
});
