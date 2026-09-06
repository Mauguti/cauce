import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "./index.ts";

describe("MockTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const nuevo = () =>
    createTransport("mock", { qrDelayMs: 100, scanDelayMs: 200 });

  it("arranca en pending", () => {
    expect(nuevo().status()).toBe("pending");
  });

  it("recorre el ciclo pending → qr → connected", async () => {
    const t = nuevo();
    await t.connect();
    expect(t.status()).toBe("pending");

    await vi.advanceTimersByTimeAsync(100);
    expect(t.status()).toBe("qr");

    await vi.advanceTimersByTimeAsync(200);
    expect(t.status()).toBe("connected");
  });

  it("expone el QR solo mientras el estado es qr", async () => {
    const t = nuevo();
    expect(await t.getQr()).toBeNull();

    await t.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(await t.getQr()).toMatch(/^cauce-mock-qr:/);

    await vi.advanceTimersByTimeAsync(200);
    expect(await t.getQr()).toBeNull();
  });

  it("envía solo cuando está connected y asigna externalId", async () => {
    const t = nuevo();
    await expect(
      t.send({ telefono: "+525500000000", cuerpo: "hola" }),
    ).rejects.toThrow(/pending/);

    await t.connect();
    await vi.advanceTimersByTimeAsync(300);

    const recibo = await t.send({ telefono: "+525500000000", cuerpo: "hola" });
    expect(recibo.externalId).toBe("mock-1");
    expect(recibo.timestamp).toBeTruthy();

    const segundo = await t.send({ telefono: "+525500000000", cuerpo: "otro" });
    expect(segundo.externalId).toBe("mock-2");
  });

  it("rechaza mensajes sin telefono o sin cuerpo", async () => {
    const t = nuevo();
    await t.connect();
    await vi.advanceTimersByTimeAsync(300);
    await expect(t.send({ telefono: "", cuerpo: "hola" })).rejects.toThrow();
    await expect(
      t.send({ telefono: "+525500000000", cuerpo: "" }),
    ).rejects.toThrow();
  });

  it("disconnect corta el ciclo y deja disconnected", async () => {
    const t = nuevo();
    await t.connect();
    await vi.advanceTimersByTimeAsync(100);
    await t.disconnect();
    expect(t.status()).toBe("disconnected");

    // El timer de escaneo quedó cancelado: no revive la sesión.
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.status()).toBe("disconnected");
    expect(await t.getQr()).toBeNull();
  });

  it("connect es idempotente en qr y connected", async () => {
    const t = nuevo();
    await t.connect();
    await vi.advanceTimersByTimeAsync(100);
    await t.connect();
    expect(t.status()).toBe("qr");
    await vi.advanceTimersByTimeAsync(200);
    await t.connect();
    expect(t.status()).toBe("connected");
  });

  it("permite reconectar después de disconnect", async () => {
    const t = nuevo();
    await t.connect();
    await vi.advanceTimersByTimeAsync(300);
    await t.disconnect();

    await t.connect();
    await vi.advanceTimersByTimeAsync(300);
    expect(t.status()).toBe("connected");
  });
});
