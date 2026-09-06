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

function armar(disparadores: DisparadorEntrada[] = []) {
  const repo = new RepositorioEnMemoria();
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
