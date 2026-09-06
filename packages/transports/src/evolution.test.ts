import { describe, expect, it, vi } from "vitest";
import { createTransport } from "./index.ts";
import { mapearEstadoEvolution } from "./evolution.ts";

function respuesta(status: number, json: unknown) {
  return {
    status,
    json: async () => json,
  } as Response;
}

function transporteConFetch(fetchImpl: typeof fetch) {
  return createTransport({
    tipo: "evolution",
    opciones: {
      baseUrl: "http://127.0.0.1:9999",
      apiKey: "clave-secreta",
      instanceName: "cauce-demo-inst1",
      fetchImpl,
    },
  });
}

describe("mapearEstadoEvolution", () => {
  it("traduce el vocabulario de Evolution al enum de core", () => {
    expect(mapearEstadoEvolution("open", false)).toBe("connected");
    expect(mapearEstadoEvolution("close", false)).toBe("disconnected");
    expect(mapearEstadoEvolution("connecting", true)).toBe("qr");
    expect(mapearEstadoEvolution("connecting", false)).toBe("pending");
    expect(mapearEstadoEvolution("algo-desconocido", false)).toBe("pending");
  });
});

describe("EvolutionTransport", () => {
  it("manda la apikey de la instancia en cada llamada", async () => {
    const fetchMock = vi.fn(async () =>
      respuesta(200, { instance: { state: "open" } }),
    );
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    await t.status();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://127.0.0.1:9999/instance/connectionState/cauce-demo-inst1",
    );
    expect(init.headers).toMatchObject({ apikey: "clave-secreta" });
  });

  it("connect crea la instancia y tolera que ya exista", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/instance/create") && init?.method === "POST") {
          return respuesta(403, { error: "ya existe" });
        }
        if (u.includes("/instance/connect/")) {
          return respuesta(200, { code: "qr-payload", base64: "data:..." });
        }
        throw new Error(`llamada inesperada: ${u}`);
      },
    );
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    await expect(t.connect()).resolves.toBeUndefined();
  });

  it("connect registra el webhook cuando se configuró la URL", async () => {
    const cuerpos: Record<string, unknown> = {};
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/instance/create")) {
          return respuesta(201, { instance: { status: "connecting" } });
        }
        if (u.endsWith("/webhook/set/cauce-demo-inst1")) {
          cuerpos.webhook = JSON.parse(String(init?.body));
          return respuesta(201, { enabled: true });
        }
        throw new Error(`llamada inesperada: ${u}`);
      },
    );
    const t = createTransport({
      tipo: "evolution",
      opciones: {
        baseUrl: "http://127.0.0.1:9999",
        apiKey: "clave-secreta",
        instanceName: "cauce-demo-inst1",
        webhookUrl: "http://host.docker.internal:3001/webhooks/demo/inst1?token=t1",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });
    await t.connect();
    expect(cuerpos.webhook).toEqual({
      webhook: {
        enabled: true,
        url: "http://host.docker.internal:3001/webhooks/demo/inst1?token=t1",
        events: ["MESSAGES_UPSERT"],
        byEvents: false,
        base64: false,
      },
    });
  });

  it("getQr devuelve código e imagen mientras hay QR, null cuando conectó", async () => {
    let conectada = false;
    const fetchMock = vi.fn(async () =>
      conectada
        ? respuesta(200, { instance: { state: "open" } })
        : respuesta(200, { code: "2@abc123", base64: "data:image/png;base64,xyz" }),
    );
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);

    expect(await t.getQr()).toEqual({
      codigo: "2@abc123",
      imagenBase64: "data:image/png;base64,xyz",
    });

    conectada = true;
    expect(await t.getQr()).toBeNull();
  });

  it("status distingue qr de pending según haya QR disponible", async () => {
    let hayQr = true;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/instance/connectionState/")) {
        return respuesta(200, { instance: { state: "connecting" } });
      }
      if (u.includes("/instance/connect/")) {
        return hayQr
          ? respuesta(200, { code: "2@abc", base64: null })
          : respuesta(200, {});
      }
      throw new Error(`llamada inesperada: ${u}`);
    });
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    expect(await t.status()).toBe("qr");
    hayQr = false;
    expect(await t.status()).toBe("pending");
  });

  it("status reporta disconnected si el contenedor no responde", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    expect(await t.status()).toBe("disconnected");
  });

  it("send exige estado connected, normaliza el teléfono y mapea el recibo", async () => {
    const cuerpos: unknown[] = [];
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/instance/connectionState/")) {
          return respuesta(200, { instance: { state: "open" } });
        }
        if (u.includes("/message/sendText/")) {
          cuerpos.push(JSON.parse(String(init?.body)));
          return respuesta(201, {
            key: { id: "BAE5F4C1" },
            messageTimestamp: 1757100000,
          });
        }
        throw new Error(`llamada inesperada: ${u}`);
      },
    );
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    const recibo = await t.send({
      telefono: "+52 55 1234 5678",
      cuerpo: "hola",
    });
    expect(cuerpos[0]).toEqual({ number: "525512345678", text: "hola" });
    expect(recibo.externalId).toBe("BAE5F4C1");
    expect(recibo.timestamp).toBe(new Date(1757100000 * 1000).toISOString());
  });

  it("send rechaza cuando la sesión no está conectada", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/instance/connectionState/")) {
        return respuesta(200, { instance: { state: "close" } });
      }
      throw new Error(`llamada inesperada: ${u}`);
    });
    const t = transporteConFetch(fetchMock as unknown as typeof fetch);
    await expect(
      t.send({ telefono: "+525512345678", cuerpo: "hola" }),
    ).rejects.toThrow(/disconnected/);
  });
});
