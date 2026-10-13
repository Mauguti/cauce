import { describe, expect, it } from "vitest";
import { clasificar, filaCsv, normalizarTelefono, separarValores } from "./espejo-telefono.ts";

describe("espejo → teléfono: qué se escribe y qué se manda a revisar", () => {
  it("un valor se normaliza y se copia (+52 a 10 dígitos; respeta lada si ya viene)", () => {
    expect(clasificar({ espejo: "442 123 4567", destinoActual: "", sobrescribir: false })).toMatchObject({ estado: "copiar", telefono: "+524421234567" });
    expect(clasificar({ espejo: "+1 (555) 010-2030", destinoActual: null, sobrescribir: false })).toMatchObject({ estado: "copiar", telefono: "+15550102030" });
    expect(normalizarTelefono("abc")).toBeNull();
  });

  it("MÁS DE UN VALOR distinto → revisar, sin teléfono: nunca se toma el primero", () => {
    const r = clasificar({ espejo: "442 123 4567, 55 9876 5432", destinoActual: "", sobrescribir: false });
    expect(r.estado).toBe("revisar");
    expect(r.telefono).toBeNull();
    expect(r.valores).toEqual(["442 123 4567", "55 9876 5432"]);
    expect(r.motivo).toContain("monday no garantiza el orden");
    // También separados por salto de línea o punto y coma.
    expect(clasificar({ espejo: "4421234567\n5598765432", destinoActual: "", sobrescribir: false }).estado).toBe("revisar");
    expect(separarValores(" a ; b ,, c ")).toEqual(["a", "b", "c"]);
  });

  it("varios valores que son el MISMO número con distinto formato cuentan como uno y se copian", () => {
    expect(clasificar({ espejo: "442 123 4567, +52 442 123 4567", destinoActual: "", sobrescribir: false })).toMatchObject({ estado: "copiar", telefono: "+524421234567" });
  });

  it("sin valor y destino ya lleno se omiten; con sobrescribir, el destino lleno sí se copia", () => {
    expect(clasificar({ espejo: "", destinoActual: "", sobrescribir: false }).estado).toBe("sin_valor");
    expect(clasificar({ espejo: "sin dígitos", destinoActual: "", sobrescribir: false }).estado).toBe("sin_valor");
    expect(clasificar({ espejo: "4421234567", destinoActual: "+524421234567", sobrescribir: false }).estado).toBe("ya_tiene");
    expect(clasificar({ espejo: "4421234567", destinoActual: "+524421234567", sobrescribir: true }).estado).toBe("copiar");
  });

  it("filaCsv escapa comillas", () => {
    expect(filaCsv(["a", 'di "hola"', null, 3])).toBe('"a","di ""hola""","","3"');
  });
});
