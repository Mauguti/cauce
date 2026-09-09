import { afterEach, describe, expect, it } from "vitest";
import {
  enmascararTelefono,
  formatear,
  registrar,
  registrarCadaMs,
  registrarError,
  usarSalida,
} from "./log.ts";

const fecha = new Date("2026-09-09T19:03:01.123Z");

describe("formatear", () => {
  it("arma una línea clave=valor con fecha, nivel y evento", () => {
    expect(
      formatear("info", "instancia.crear", { tenant: "t1", instancia: "i1", ms: 42, ok: true }, fecha),
    ).toBe("2026-09-09T19:03:01.123Z info instancia.crear tenant=t1 instancia=i1 ms=42 ok=true");
  });

  it("cita valores con espacios, comillas o signo igual, y omite null/undefined", () => {
    expect(
      formatear("warn", "x", { a: "con espacio", b: 'di"jo', c: "k=v", d: null, e: undefined, f: "" }, fecha),
    ).toBe('2026-09-09T19:03:01.123Z warn x a="con espacio" b="di\\"jo" c="k=v" f=""');
  });

  it("aplana saltos de línea para que cada evento sea una sola línea", () => {
    expect(formatear("error", "x", { error: "línea 1\nlínea 2" }, fecha)).toBe(
      '2026-09-09T19:03:01.123Z error x error="línea 1 línea 2"',
    );
  });

  it("serializa objetos y toma el mensaje de los Error", () => {
    expect(formatear("info", "x", { o: { a: 1 }, e: new Error("falló") }, fecha)).toBe(
      '2026-09-09T19:03:01.123Z info x o="{\\"a\\":1}" e=falló',
    );
  });
});

describe("enmascararTelefono", () => {
  it("deja solo los últimos 4 dígitos y el prefijo de país", () => {
    expect(enmascararTelefono("+5214428575347")).toBe("+521••••5347");
    expect(enmascararTelefono("5215512345678")).toBe("521••••5678");
    expect(enmascararTelefono("+52 55 1234 5678")).toBe("+52••••5678");
  });
  it("no revela nada con pocos dígitos o vacío", () => {
    expect(enmascararTelefono("1234")).toBe("••••");
    expect(enmascararTelefono(null)).toBe("••••");
  });
});

describe("registrar / registrarCadaMs", () => {
  const lineas: string[] = [];
  afterEach(() => {
    lineas.length = 0;
    usarSalida(null);
  });

  it("registrarError va a nivel error con error=<mensaje>", () => {
    usarSalida((_n, l) => lineas.push(l));
    registrarError("envio.fallido", new Error("sin sesión"), { tenant: "t" });
    expect(lineas[0]).toMatch(/ error envio\.fallido tenant=t error="sin sesión"$/);
  });

  it("registrarCadaMs acota repeticiones por clave", () => {
    usarSalida((_n, l) => lineas.push(l));
    expect(registrarCadaMs("qr:i1", 60_000, "qr.servido", {}, "info", 1_000)).toBe(true);
    expect(registrarCadaMs("qr:i1", 60_000, "qr.servido", {}, "info", 30_000)).toBe(false);
    expect(registrarCadaMs("qr:i2", 60_000, "qr.servido", {}, "info", 30_000)).toBe(true);
    expect(registrarCadaMs("qr:i1", 60_000, "qr.servido", {}, "info", 61_001)).toBe(true);
    expect(lineas).toHaveLength(3);
  });

  it("registrar va por console cuando no hay salida de prueba", () => {
    registrar("prueba.evento", { a: 1 }); // no debe lanzar
  });
});
