import { describe, expect, it } from "vitest";
import type { Message } from "@cauce/core";
import { MotorEntrada } from "./motor.ts";
import type { DisparadorEntrada } from "./disparadores.ts";
import { RepositorioEnMemoria } from "../store.ts";

function entrante(cuerpo: string, telefono = "+525512345678"): Message {
  return {
    id: crypto.randomUUID(),
    tenantId: "demo",
    instanceId: "i1",
    direccion: "in",
    telefono,
    cuerpo,
    estado: "recibido",
    externalId: null,
    timestamp: new Date().toISOString(),
  };
}

function armar(disparadores: DisparadorEntrada[] = [], plan: "basico" | "estandar" | "pro" = "estandar") {
  // El tenant importa: los bots solo corren si su plan los incluye.
  const repo = new RepositorioEnMemoria({
    tenants: [{ id: "demo", nombre: "Demo", plan, estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z" }],
  });
  void repo.saveDisparadores("demo", disparadores);
  const enviados: { telefono: string; cuerpo: string }[] = [];
  const motor = new MotorEntrada({
    repo,
    enviarInmediato: async (_t, _i, telefono, cuerpo) => {
      enviados.push({ telefono, cuerpo });
    },
  });
  return { repo, motor, enviados };
}

const BIENVENIDA: DisparadorEntrada = {
  id: "bienvenida",
  prioridad: 1,
  tipo: "primer_contacto",
  activo: true,
  respuesta: "¡Hola! Gracias por escribir.",
};

describe("MotorEntrada", () => {
  it("responde primer_contacto solo la primera vez", async () => {
    const { motor, enviados } = armar([BIENVENIDA]);
    await motor.procesar("demo", "i1", entrante("hola"));
    await motor.procesar("demo", "i1", entrante("otra vez"));
    expect(enviados).toEqual([
      { telefono: "+525512345678", cuerpo: "¡Hola! Gracias por escribir." },
    ]);
  });

  it("actualiza ultimoEntranteEn en cada mensaje", async () => {
    const { repo, motor } = armar();
    await motor.procesar("demo", "i1", entrante("uno"));
    const c1 = await repo.getConversacion("demo", "i1", "525512345678");
    await new Promise((r) => setTimeout(r, 5));
    await motor.procesar("demo", "i1", entrante("dos"));
    const c2 = await repo.getConversacion("demo", "i1", "525512345678");
    expect(c1?.primerContactoEn).toBe(c2?.primerContactoEn);
    expect(c2!.ultimoEntranteEn! >= c1!.ultimoEntranteEn!).toBe(true);
  });

  it("no responde si ningún disparador coincide", async () => {
    const { motor, enviados } = armar([
      { id: "k", prioridad: 1, tipo: "palabra_clave", patron: "baja", activo: true, respuesta: "ok" },
    ]);
    await motor.procesar("demo", "i1", entrante("hola"));
    expect(enviados).toHaveLength(0);
  });

  it("condición de carrera: dos entrantes simultáneos → un solo primer_contacto", async () => {
    const { motor, enviados } = armar([BIENVENIDA]);
    // Dos mensajes del mismo número procesados en paralelo.
    await Promise.all([
      motor.procesar("demo", "i1", entrante("hola 1")),
      motor.procesar("demo", "i1", entrante("hola 2")),
    ]);
    // Exactamente una bienvenida, no dos.
    expect(enviados).toHaveLength(1);
  });
});

describe("MotorEntrada por plan", () => {
  it("un tenant Básico conserva sus disparadores configurados pero NO responde: los bots quedan en pausa", async () => {
    const { motor, enviados, repo } = armar(
      [{ id: "d1", prioridad: 10, tipo: "cualquiera", activo: true, respuesta: "Hola" }],
      "basico",
    );
    await motor.procesar("demo", "i1", entrante("hola"));
    expect(enviados).toEqual([]);
    expect(await repo.getDisparadores("demo")).toHaveLength(1); // configuración intacta
  });

  it("el mismo tenant en Estándar sí responde", async () => {
    const { motor, enviados } = armar(
      [{ id: "d1", prioridad: 10, tipo: "cualquiera", activo: true, respuesta: "Hola" }],
      "estandar",
    );
    await motor.procesar("demo", "i1", entrante("hola"));
    expect(enviados).toHaveLength(1);
  });
});

/**
 * G2 — Fail-open: si la lectura de energía falla, el agente responde de
 * todos modos y el fallo se registra en bitácora en nivel warn.
 */
describe("MotorEntrada fail-open de energía (G2)", () => {
  it("si la lectura de energía lanza, el agente responde y se registra warn en bitácora", async () => {
    const { usarSalida } = await import("../log.ts");
    const logs: string[] = [];
    usarSalida((_nivel, linea) => logs.push(linea));

    const repo = new RepositorioEnMemoria({
      tenants: [{
        id: "demo", nombre: "Demo", plan: "pro", estado: "activo",
        apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
        agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5" },
      }],
    });
    const enviados: { telefono: string; cuerpo: string }[] = [];
    const motor = new MotorEntrada({
      repo,
      enviarInmediato: async (_t, _i, telefono, cuerpo) => {
        enviados.push({ telefono, cuerpo });
      },
      // Agente que siempre responde.
      agente: { responder: async () => ({ texto: "Hola, ¿en qué puedo ayudarte?", costoUsd: 0.01 }) } as any,
      // precios() que lanza: simula un fallo de Firestore.
      precios: async () => { throw new Error("Firestore timeout"); },
      tipoCambio: { usdMxn: 20, colchon: 1.1 },
    });

    await motor.procesar("demo", "i1", entrante("hola"));

    // El agente respondió a pesar del error de energía.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.cuerpo).toBe("Hola, ¿en qué puedo ayudarte?");

    // El error quedó registrado en nivel warn.
    const warnLog = logs.find((l) => l.includes("energia.error_lectura"));
    expect(warnLog).toBeDefined();
    expect(warnLog).toContain("warn");
    expect(warnLog).toContain("Firestore timeout");

    usarSalida(null);
  });
});

/**
 * G5 — Suspensión: un tenant suspendido recibe mensajes y envía un aviso
 * automático UNA SOLA VEZ por conversación. No responde bots ni agentes.
 */
describe("MotorEntrada con tenant suspendido (G5)", () => {
  it("envía aviso de suspensión una sola vez por conversación, no repite", async () => {
    const { usarSalida } = await import("../log.ts");
    usarSalida(() => {});

    const repo = new RepositorioEnMemoria({
      tenants: [{
        id: "demo", nombre: "Demo", plan: "pro", estado: "suspendido" as any,
        apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
      }],
    });
    void repo.saveDisparadores("demo", [
      { id: "d1", prioridad: 10, tipo: "cualquiera", activo: true, respuesta: "Hola" },
    ]);
    const enviados: { telefono: string; cuerpo: string }[] = [];
    const motor = new MotorEntrada({
      repo,
      enviarInmediato: async (_t, _i, telefono, cuerpo) => {
        enviados.push({ telefono, cuerpo });
      },
    });

    // Primer mensaje: aviso enviado.
    await motor.procesar("demo", "i1", entrante("hola"));
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.cuerpo).toContain("pausado");

    // Segundo mensaje del mismo contacto: sin aviso repetido.
    await motor.procesar("demo", "i1", entrante("¿hay alguien?"));
    expect(enviados).toHaveLength(1); // no cambió

    // Otro contacto SÍ recibe su propio aviso.
    await motor.procesar("demo", "i1", entrante("buenas", "+525599998888"));
    expect(enviados).toHaveLength(2);

    usarSalida(null);
  });

  it("no responde bots ni agentes cuando está suspendido", async () => {
    const { usarSalida } = await import("../log.ts");
    usarSalida(() => {});

    const repo = new RepositorioEnMemoria({
      tenants: [{
        id: "demo", nombre: "Demo", plan: "pro", estado: "suspendido" as any,
        apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
        agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5" },
      }],
    });
    void repo.saveDisparadores("demo", [
      { id: "d1", prioridad: 10, tipo: "cualquiera", activo: true, respuesta: "Hola del bot" },
    ]);
    const enviados: { telefono: string; cuerpo: string }[] = [];
    const motor = new MotorEntrada({
      repo,
      enviarInmediato: async (_t, _i, telefono, cuerpo) => {
        enviados.push({ telefono, cuerpo });
      },
      agente: { responder: async () => ({ texto: "Hola del agente", costoUsd: 0 }) } as any,
    });

    await motor.procesar("demo", "i1", entrante("hola"));

    // Solo se envió el aviso de suspensión, no el bot ni el agente.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.cuerpo).not.toContain("bot");
    expect(enviados[0]!.cuerpo).not.toContain("agente");
    expect(enviados[0]!.cuerpo).toContain("pausado");

    usarSalida(null);
  });

  it("el mensaje entrante se registra en la conversación aunque esté suspendido", async () => {
    const { usarSalida } = await import("../log.ts");
    usarSalida(() => {});

    const repo = new RepositorioEnMemoria({
      tenants: [{
        id: "demo", nombre: "Demo", plan: "pro", estado: "suspendido" as any,
        apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
      }],
    });
    const motor = new MotorEntrada({
      repo,
      enviarInmediato: async () => {},
    });

    await motor.procesar("demo", "i1", entrante("hola"));

    const conv = await repo.getConversacion("demo", "i1", "525512345678");
    expect(conv).not.toBeNull();
    expect(conv!.primerContactoEn).not.toBeNull();
    expect(conv!.ultimoEntranteEn).not.toBeNull();

    usarSalida(null);
  });
});
