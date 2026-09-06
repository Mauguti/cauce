import { describe, expect, it } from "vitest";
import {
  coincide,
  dentroDeHorario,
  primeroQueCoincide,
  type DisparadorEntrada,
} from "./disparadores.ts";

const base = { activo: true, respuesta: "r", prioridad: 0 } as const;
const ctx = (over: Partial<{ texto: string; esPrimerContacto: boolean; ahora: Date }>) => ({
  texto: "hola",
  esPrimerContacto: false,
  ahora: new Date("2026-09-07T18:00:00Z"),
  ...over,
});

describe("coincide", () => {
  it("cualquiera coincide siempre; inactivo nunca", () => {
    expect(coincide({ ...base, id: "1", tipo: "cualquiera" }, ctx({}))).toBe(true);
    expect(
      coincide({ ...base, id: "1", tipo: "cualquiera", activo: false }, ctx({})),
    ).toBe(false);
  });

  it("primer_contacto solo en el primer entrante", () => {
    const d: DisparadorEntrada = { ...base, id: "1", tipo: "primer_contacto" };
    expect(coincide(d, ctx({ esPrimerContacto: true }))).toBe(true);
    expect(coincide(d, ctx({ esPrimerContacto: false }))).toBe(false);
  });

  it("palabra_clave: contiene (default) e igual, sin acentos ni mayúsculas", () => {
    const contiene: DisparadorEntrada = { ...base, id: "1", tipo: "palabra_clave", patron: "baja" };
    expect(coincide(contiene, ctx({ texto: "Quiero darme de BAJA ya" }))).toBe(true);
    expect(coincide(contiene, ctx({ texto: "hola" }))).toBe(false);

    const igual: DisparadorEntrada = { ...base, id: "2", tipo: "palabra_clave", patron: "adiós", coincidencia: "igual" };
    expect(coincide(igual, ctx({ texto: "ADIOS" }))).toBe(true);
    expect(coincide(igual, ctx({ texto: "adiós amigo" }))).toBe(false);
  });
});

describe("dentroDeHorario / fuera_horario", () => {
  const horario = { tz: "America/Mexico_City", dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "18:00" };

  it("distingue dentro y fuera del horario laboral en la tz dada", () => {
    // 2026-09-07 es lunes. 15:00Z = 09:00 en CDMX (UTC-6) → dentro.
    expect(dentroDeHorario(horario, new Date("2026-09-07T15:00:00Z"))).toBe(true);
    // 05:00Z = 23:00 del domingo en CDMX → fuera (y domingo no laboral).
    expect(dentroDeHorario(horario, new Date("2026-09-07T05:00:00Z"))).toBe(false);
    // 03:00Z lunes = 21:00 domingo CDMX → fuera.
    expect(dentroDeHorario(horario, new Date("2026-09-07T03:00:00Z"))).toBe(false);
  });

  it("fuera_horario coincide justo cuando NO es horario laboral", () => {
    const d: DisparadorEntrada = { ...base, id: "1", tipo: "fuera_horario", horario };
    // 15:00Z lunes = 09:00 CDMX → dentro → NO dispara ausencia.
    expect(coincide(d, ctx({ ahora: new Date("2026-09-07T15:00:00Z") }))).toBe(false);
    // 06:00Z lunes = 00:00 CDMX → fuera → dispara.
    expect(coincide(d, ctx({ ahora: new Date("2026-09-07T06:00:00Z") }))).toBe(true);
  });
});

describe("primeroQueCoincide", () => {
  it("evalúa por prioridad ascendente y la primera coincidencia gana", () => {
    const disparadores: DisparadorEntrada[] = [
      { ...base, id: "generico", tipo: "cualquiera", prioridad: 100, respuesta: "generico" },
      { ...base, id: "clave", tipo: "palabra_clave", patron: "factura", prioridad: 10, respuesta: "factura" },
      { ...base, id: "primer", tipo: "primer_contacto", prioridad: 5, respuesta: "bienvenida" },
    ];
    // Primer contacto con "factura": gana prioridad 5 (primer_contacto).
    expect(
      primeroQueCoincide(disparadores, ctx({ texto: "mi factura", esPrimerContacto: true }))?.id,
    ).toBe("primer");
    // No primer contacto con "factura": gana palabra_clave (10) sobre generico (100).
    expect(
      primeroQueCoincide(disparadores, ctx({ texto: "mi factura", esPrimerContacto: false }))?.id,
    ).toBe("clave");
    // Sin palabra clave ni primer contacto: cae al genérico.
    expect(
      primeroQueCoincide(disparadores, ctx({ texto: "cualquier cosa" }))?.id,
    ).toBe("generico");
  });

  it("devuelve null si ninguno coincide", () => {
    const disparadores: DisparadorEntrada[] = [
      { ...base, id: "clave", tipo: "palabra_clave", patron: "xyz", prioridad: 1 },
    ];
    expect(primeroQueCoincide(disparadores, ctx({ texto: "hola" }))).toBeNull();
  });
});
