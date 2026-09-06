import { describe, expect, it } from "vitest";
import { diagnosticarEnvio, telefonoValido } from "./errores.ts";

describe("telefonoValido", () => {
  it("acepta E.164-ish y rechaza lo demás", () => {
    expect(telefonoValido("+52 55 1234 5678")).toBe(true);
    expect(telefonoValido("5215512345678")).toBe(true);
    expect(telefonoValido("123")).toBe(false);
    expect(telefonoValido("")).toBe(false);
  });
});

describe("diagnosticarEnvio distingue las causas", () => {
  it("sesión desconectada", () => {
    const d = diagnosticarEnvio('No se puede enviar en estado "disconnected"; la sesión debe estar connected');
    expect(d.codigo).toBe("sesion_desconectada");
    expect(d.reintentable).toBe(true);
    expect(d.mensaje).toMatch(/Reconéctala/);
  });

  it("teléfono inválido (no reintentable)", () => {
    const d = diagnosticarEnvio("teléfono inválido (formato)");
    expect(d.codigo).toBe("telefono_invalido");
    expect(d.reintentable).toBe(false);
  });

  it("rechazo del transporte", () => {
    const d = diagnosticarEnvio('Evolution rechazó sendText (400): {"error":"bad number"}');
    expect(d.codigo).toBe("transporte_rechazo");
    expect(d.reintentable).toBe(true);
  });

  it("desconocido conserva el detalle", () => {
    const d = diagnosticarEnvio("boom inesperado");
    expect(d.codigo).toBe("desconocido");
    expect(d.mensaje).toMatch(/boom inesperado/);
  });
});
