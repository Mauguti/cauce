import { describe, expect, it } from "vitest";
import {
  sesionPareceDegradada,
  UMBRAL_SIN_CONFIRMAR_MS,
  type Message,
} from "@cauce/core";
import { barrerSinConfirmar } from "./confirmaciones.ts";
import { RepositorioEnMemoria } from "./store.ts";

const T = "2026-09-06T12:00:00Z";
function saliente(over: Partial<Message>): Message {
  return {
    id: over.id ?? "m", tenantId: "a", instanceId: "i1", direccion: "out",
    telefono: "+5215500000000", cuerpo: "x", estado: "enviado",
    externalId: "e", timestamp: T, ...over,
  };
}

describe("barrerSinConfirmar", () => {
  it("marca no_confirmado los enviados viejos sin confirmar; respeta el resto", async () => {
    const ahora = new Date("2026-09-06T12:10:00Z"); // 10 min después
    const repo = new RepositorioEnMemoria({
      tenants: [{ id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: T }],
    });
    // Viejo sin confirmar → debe marcarse.
    await repo.saveMessage(saliente({ id: "viejo" }));
    // Viejo pero ya confirmado → intacto.
    await repo.saveMessage(saliente({ id: "confirmado", confirmadoEn: "2026-09-06T12:00:05Z" }));
    // Reciente → todavía no.
    await repo.saveMessage(saliente({ id: "reciente", timestamp: "2026-09-06T12:09:30Z" }));
    // Entrante → no aplica.
    await repo.saveMessage(saliente({ id: "in", direccion: "in", estado: "recibido" }));

    const n = await barrerSinConfirmar(repo, ahora);
    expect(n).toBe(1);
    expect((await repo.getMessage("a", "viejo"))!.estado).toBe("no_confirmado");
    expect((await repo.getMessage("a", "confirmado"))!.estado).toBe("enviado");
    expect((await repo.getMessage("a", "reciente"))!.estado).toBe("enviado");
    expect((await repo.getMessage("a", "in"))!.estado).toBe("recibido");
  });

  it("es idempotente y respeta el umbral configurable", async () => {
    const ahora = new Date(new Date(T).getTime() + UMBRAL_SIN_CONFIRMAR_MS + 1000);
    const repo = new RepositorioEnMemoria({
      tenants: [{ id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: T }],
    });
    await repo.saveMessage(saliente({ id: "m1" }));
    expect(await barrerSinConfirmar(repo, ahora)).toBe(1);
    expect(await barrerSinConfirmar(repo, ahora)).toBe(0); // ya marcado
  });
});

describe("sesionPareceDegradada", () => {
  const m = (id: string, estado: Message["estado"]): Message =>
    saliente({ id, estado, timestamp: `2026-09-06T12:0${id}:00Z` });
  const confirmado = (id: string): Message =>
    saliente({ id, estado: "enviado", confirmadoEn: `2026-09-06T12:0${id}:30Z`, timestamp: `2026-09-06T12:0${id}:00Z` });

  it("verdadero con >= 3 sin confirmar recientes SI el canal confirmó antes", () => {
    // Un envío previo confirmado prueba que el canal funciona; la racha
    // de no_confirmados que sigue sí es degradación real.
    expect(
      sesionPareceDegradada([
        confirmado("1"),
        m("2", "no_confirmado"),
        m("3", "no_confirmado"),
        m("4", "no_confirmado"),
      ]),
    ).toBe(true);
  });

  it("FALSO si NUNCA se confirmó nada (tubería rota, no número degradado)", () => {
    // El caso del falso positivo en producción: 25 sin confirmar y 0
    // confirmados => es el webhook/emisión, no el número. No se alerta.
    expect(
      sesionPareceDegradada([
        m("1", "no_confirmado"),
        m("2", "no_confirmado"),
        m("3", "no_confirmado"),
        m("4", "no_confirmado"),
      ]),
    ).toBe(false);
  });

  it("falso si los envíos recientes se confirmaron o no hay suficientes", () => {
    expect(
      sesionPareceDegradada([confirmado("1"), confirmado("2"), confirmado("3")]),
    ).toBe(false);
    expect(sesionPareceDegradada([confirmado("1"), m("2", "no_confirmado")])).toBe(false);
  });
});
