import { afterEach, describe, expect, it } from "vitest";
import type { Message, Tenant } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { CORTACIRCUITOS, MotorEntrada } from "./motor.ts";
import { Agente } from "../agentes/agente.ts";
import type { ProveedorModelo } from "../agentes/proveedor.ts";

const TENANT: Tenant = {
  id: "t1", nombre: "Digsol", plan: "pro", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
  agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5" },
};
const OTRO: Tenant = { id: "t2", nombre: "Procesa", plan: "estandar", estado: "activo", apiKeyHash: "y".repeat(64), creadoEn: "2026-09-05T00:00:00Z" };

function entrante(telefono: string, cuerpo = "hola"): Message {
  return { id: crypto.randomUUID(), tenantId: "t1", instanceId: "A", direccion: "in", telefono, cuerpo, estado: "recibido", externalId: null, timestamp: new Date().toISOString() };
}

function armar(opciones: { respuesta?: (n: number) => string; avisos?: string } = {}) {
  const repo = new RepositorioEnMemoria({
    tenants: [TENANT, OTRO],
    instances: [
      { id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000001", estado: "connected", ultimoHeartbeat: null },
      { id: "B", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000002", estado: "connected", ultimoHeartbeat: null },
      { id: "P", tenantId: "t2", transportType: "mock", contenedorId: null, numero: "+5214420000009", estado: "connected", ultimoHeartbeat: null },
    ],
  });
  let n = 0;
  const proveedor: ProveedorModelo = {
    nombre: "anthropic",
    async responder() {
      n += 1;
      return { texto: opciones.respuesta ? opciones.respuesta(n) : `respuesta ${n}`, modelo: "claude-opus-5", uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 }, costoUsd: 0.0001, parada: "end_turn", herramientasUsadas: [] };
    },
  };
  let reloj = Date.parse("2026-09-15T04:00:00Z");
  const enviados: { telefono: string; cuerpo: string }[] = [];
  const motor = new MotorEntrada({
    repo,
    agente: new Agente({ repo, proveedores: { anthropic: proveedor } }),
    ...(opciones.avisos ? { avisosWhatsApp: opciones.avisos } : {}),
    ahora: () => reloj,
    enviarInmediato: async (_t, _i, telefono, cuerpo) => { enviados.push({ telefono, cuerpo }); },
  });
  const bitacora: string[] = [];
  usarSalida((_n, l) => { bitacora.push(l); });
  return { repo, motor, enviados, bitacora, avanzar: (ms: number) => { reloj += ms; }, llamadas: () => n };
}
afterEach(() => usarSalida(null));

describe("anti-bucle 1 · remitente es línea propia", () => {
  it("un mensaje desde otra línea del MISMO tenant se guarda pero no recibe respuesta automática, y la bitácora lo dice", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", entrante("+5214420000002"), "Línea B");
    expect(c.enviados).toEqual([]);
    expect(c.llamadas()).toBe(0);
    expect(c.bitacora.at(-1)).toMatch(/entrada\.respuesta .*resultado=ninguna origen="remitente es línea propia \(mismo tenant: B\)"/);
    // La conversación sí quedó registrada: es tráfico real.
    expect(await c.repo.getConversacion("t1", "A", "5214420000002")).not.toBeNull();
  });

  it("también con el 1 de WhatsApp de por medio (+52 vs +521) y desde una línea de OTRO tenant", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", entrante("+524420000002"));
    expect(c.bitacora.at(-1)).toMatch(/línea propia \(mismo tenant: B\)/);
    await c.motor.procesar("t1", "A", entrante("+5214420000009"));
    expect(c.bitacora.at(-1)).toMatch(/línea propia \(otro tenant: P\)/);
    expect(c.enviados).toEqual([]);
  });

  it("un número ajeno sí recibe respuesta", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", entrante("+5215512345678"));
    expect(c.enviados).toHaveLength(1);
  });
});

describe("anti-bucle 2 · cortacircuitos por conversación", () => {
  it("más de MAX respuestas automáticas en la ventana sin humano → se apaga, se registra y se avisa por WhatsApp", async () => {
    const c = armar({ avisos: "+5214428575347" });
    for (let k = 0; k <= CORTACIRCUITOS.max; k += 1) {
      await c.motor.procesar("t1", "A", entrante("+5215512345678", `msg ${k}`));
      c.avanzar(20_000);
    }
    const respuestasAlContacto = c.enviados.filter((e) => e.telefono === "+5215512345678");
    expect(respuestasAlContacto).toHaveLength(CORTACIRCUITOS.max + 1);
    const aviso = c.enviados.find((e) => e.telefono === "+5214428575347");
    expect(aviso?.cuerpo).toMatch(/cortacircuitos/);
    expect(c.bitacora.some((l) => l.includes("error cortacircuitos.disparado") && l.includes("respuestas automáticas en 10 min"))).toBe(true);
    // El siguiente entrante ya no dispara nada y lo dice
    await c.motor.procesar("t1", "A", entrante("+5215512345678", "¿sigues?"));
    expect(c.enviados.filter((e) => e.telefono === "+5215512345678")).toHaveLength(CORTACIRCUITOS.max + 1);
    expect(c.bitacora.at(-1)).toMatch(/cortacircuitos activo hasta/);
    const conv = (await c.repo.getConversacion("t1", "A", "5215512345678"))!;
    expect(conv.cortacircuitos?.conteo).toBe(CORTACIRCUITOS.max + 1);
  });

  it("respuestas idénticas seguidas en pocos minutos → se apaga antes de llegar al tope", async () => {
    const c = armar({ respuesta: () => "Hola, ¿en qué te ayudo?" });
    for (let k = 0; k < CORTACIRCUITOS.repeticiones; k += 1) {
      await c.motor.procesar("t1", "A", entrante("+5215512345678", `eco ${k}`));
      c.avanzar(10_000);
    }
    expect(c.bitacora.some((l) => l.includes("cortacircuitos.disparado") && l.includes("idénticas seguidas"))).toBe(true);
    await c.motor.procesar("t1", "A", entrante("+5215512345678", "otra"));
    expect(c.enviados).toHaveLength(CORTACIRCUITOS.repeticiones);
  });

  it("una conversación normal, espaciada, no lo dispara", async () => {
    const c = armar();
    for (let k = 0; k < CORTACIRCUITOS.max + 3; k += 1) {
      await c.motor.procesar("t1", "A", entrante("+5215512345678", `pregunta ${k}`));
      c.avanzar(2 * 60_000);
    }
    expect(c.bitacora.some((l) => l.includes("cortacircuitos.disparado"))).toBe(false);
    expect(c.enviados).toHaveLength(CORTACIRCUITOS.max + 3);
  });

  it("un operador que contesta levanta la pausa", async () => {
    const c = armar({ respuesta: () => "igual" });
    for (let k = 0; k < CORTACIRCUITOS.repeticiones; k += 1) { await c.motor.procesar("t1", "A", entrante("+5215512345678", `e${k}`)); c.avanzar(5_000); }
    expect((await c.repo.getConversacion("t1", "A", "5215512345678"))!.autoPausadaHasta).toBeTruthy();
    await c.repo.marcarHumana("t1", "A", "5215512345678", new Date(Date.now() + 60_000).toISOString());
    const conv = (await c.repo.getConversacion("t1", "A", "5215512345678"))!;
    expect(conv.autoPausadaHasta).toBeNull();
    expect(conv.autoRespuestas).toEqual([]);
  });
});
