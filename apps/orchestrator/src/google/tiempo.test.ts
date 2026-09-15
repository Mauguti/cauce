import { describe, expect, it } from "vitest";
import { describir, fechaLocal, horaLocal, instanteEn, partesEn, sumarDias } from "./tiempo.ts";

describe("tiempo: siempre en la zona del calendario", () => {
  it("Querétaro (UTC−6 fijo) y Tijuana (cambia con el horario de verano) dan instantes distintos para la misma hora local", () => {
    const qro = instanteEn("America/Mexico_City", "2026-09-20", "15:00");
    const tij = instanteEn("America/Tijuana", "2026-09-20", "15:00");
    expect(qro.toISOString()).toBe("2026-09-20T21:00:00.000Z");
    expect(tij.toISOString()).toBe("2026-09-20T22:00:00.000Z"); // PDT, UTC−7
    // En invierno Tijuana vuelve a UTC−8
    expect(instanteEn("America/Tijuana", "2026-12-20", "15:00").toISOString()).toBe("2026-12-20T23:00:00.000Z");
  });

  it("un mismo instante se lee como hora distinta según la zona; 'tu cita es a las 3' sale de la zona del calendario", () => {
    const i = new Date("2026-09-20T21:00:00Z");
    expect(horaLocal("America/Mexico_City", i)).toBe("15:00");
    expect(horaLocal("America/Tijuana", i)).toBe("14:00");
    expect(fechaLocal("America/Mexico_City", new Date("2026-09-21T03:30:00Z"))).toBe("2026-09-20");
    expect(partesEn("America/Mexico_City", i).diaSemana).toBe(0); // domingo
    expect(describir("America/Tijuana", i)).toMatch(/dom.*20.*sep.*14:00/);
  });

  it("sumarDias cruza mes y año", () => {
    expect(sumarDias("2026-12-30", 3)).toBe("2027-01-02");
  });
});
