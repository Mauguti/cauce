import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@cauce/core";
import { createTransport, type MessageTransport } from "@cauce/transports";
import { ColaEnvios } from "./cola.ts";
import { RepositorioEnMemoria } from "./store.ts";

function transporteFalso(fallosIniciales = 0) {
  const envios: { telefono: string; cuerpo: string; en: number }[] = [];
  let fallos = fallosIniciales;
  const transport: MessageTransport = {
    connect: async () => {},
    disconnect: async () => {},
    getQr: async () => null,
    status: async () => "connected",
    numero: async () => null,
    send: async (m) => {
      if (fallos > 0) {
        fallos -= 1;
        throw new Error("falla simulada");
      }
      envios.push({ ...m, en: Date.now() });
      return { externalId: `ext-${envios.length}`, timestamp: new Date().toISOString() };
    },
  };
  return { transport, envios };
}

function mensaje(id: string, instanceId = "i1"): Message {
  return {
    id,
    tenantId: "a",
    instanceId,
    direccion: "out",
    telefono: "+5215500000000",
    cuerpo: `cuerpo ${id}`,
    estado: "encolado",
    externalId: null,
    timestamp: new Date().toISOString(),
  };
}

const repoNuevo = () => new RepositorioEnMemoria();

const esperarHasta = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
) => {
  const limite = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(await cond()).toBe(true);
};

describe("ColaEnvios", () => {
  it("envía en orden respetando el intervalo por instancia", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repo = repoNuevo();
    const cola = new ColaEnvios({
      dir,
      repo,
      intervaloMs: 120,
      jitterMaxMs: 40,
      backoffBaseMs: 50,
    });
    const { transport, envios } = transporteFalso();
    cola.registrar("i1", transport);

    await cola.encolar(mensaje("m1"));
    await cola.encolar(mensaje("m2"));
    await cola.encolar(mensaje("m3"));

    await esperarHasta(() => envios.length === 3);
    cola.baja("i1");

    expect(envios.map((e) => e.cuerpo)).toEqual([
      "cuerpo m1",
      "cuerpo m2",
      "cuerpo m3",
    ]);
    // Entre envíos consecutivos pasó al menos el intervalo base.
    expect(envios[1]!.en - envios[0]!.en).toBeGreaterThanOrEqual(120);
    expect(envios[2]!.en - envios[1]!.en).toBeGreaterThanOrEqual(120);

    const mensajes = await repo.listMessages("a", "i1");
    expect(mensajes.every((m) => m.estado === "enviado")).toBe(true);
    expect(mensajes.map((m) => m.externalId)).toEqual(["ext-1", "ext-2", "ext-3"]);
  });

  it("reintenta con backoff y marca fallido al agotar intentos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repo = repoNuevo();
    const cola = new ColaEnvios({
      dir,
      repo,
      intervaloMs: 10,
      jitterMaxMs: 5,
      intentosMax: 3,
      backoffBaseMs: 40,
      backoffFactor: 2,
    });
    // Falla siempre.
    const { transport } = transporteFalso(Infinity);
    cola.registrar("i1", transport);
    const inicio = Date.now();
    await cola.encolar(mensaje("m1"));

    await esperarHasta(async () => {
      const [m] = await repo.listMessages("a", "i1");
      return m?.estado === "fallido";
    }, 8000);
    cola.baja("i1");

    // 3 intentos con backoff 40 + 80 entre ellos: al menos ~120ms.
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(120);
    expect(cola.pendientes("i1")).toBe(0);
    // La causa quedó guardada para el registro de envíos.
    const [m] = await repo.listMessages("a", "i1");
    expect(m!.error).toBeTruthy();
    expect(m!.errorCodigo).toBe("desconocido");
  });

  it("teléfono inválido falla de una vez (no reintentable) con su causa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repo = repoNuevo();
    const cola = new ColaEnvios({ dir, repo, intervaloMs: 10, jitterMaxMs: 5 });
    const { transport, envios } = transporteFalso();
    cola.registrar("i1", transport);
    await cola.encolar({ ...mensaje("m1"), telefono: "123" });

    await esperarHasta(async () => {
      const [m] = await repo.listMessages("a", "i1");
      return m?.estado === "fallido";
    }, 3000);
    cola.baja("i1");
    const [m] = await repo.listMessages("a", "i1");
    expect(m!.errorCodigo).toBe("telefono_invalido");
    expect(envios).toHaveLength(0); // nunca llegó al transporte
  });

  it("un reintento posterior puede terminar en enviado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repo = repoNuevo();
    const cola = new ColaEnvios({
      dir,
      repo,
      intervaloMs: 10,
      jitterMaxMs: 5,
      intentosMax: 3,
      backoffBaseMs: 30,
      backoffFactor: 2,
    });
    const { transport, envios } = transporteFalso(1); // falla 1 vez
    cola.registrar("i1", transport);
    await cola.encolar(mensaje("m1"));

    await esperarHasta(() => envios.length === 1, 5000);
    cola.baja("i1");
    const [m] = await repo.listMessages("a", "i1");
    expect(m!.estado).toBe("enviado");
  });

  it("un 404 de Evolution deja el mensaje fallido, jamás enviado", async () => {
    // Regresión del bug de producción: sendText devolvía 404 (nombre de
    // instancia equivocado) pero el mensaje se marcaba enviado. Con un
    // EvolutionTransport real sobre un fetch que responde 404, el mensaje
    // debe terminar fallido y con el cuerpo del error a la vista.
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repo = repoNuevo();
    const cola = new ColaEnvios({
      dir,
      repo,
      intervaloMs: 10,
      jitterMaxMs: 5,
      intentosMax: 1,
    });
    const fetchMock = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/instance/connectionState/")) {
        return { status: 200, json: async () => ({ instance: { state: "open" } }) } as Response;
      }
      if (u.includes("/message/sendText/")) {
        return {
          status: 404,
          json: async () => ({ message: ['The "1989a8d9" instance does not exist'] }),
        } as Response;
      }
      throw new Error(`llamada inesperada: ${u}`);
    };
    const transport = createTransport({
      tipo: "evolution",
      opciones: {
        baseUrl: "http://127.0.0.1:9999",
        apiKey: "k",
        instanceName: "cauce-b6eba985-1989a8d9",
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    });
    cola.registrar("i1", transport);
    await cola.encolar(mensaje("m1"));

    await esperarHasta(async () => {
      const [m] = await repo.listMessages("a", "i1");
      return m?.estado === "fallido";
    }, 3000);
    cola.baja("i1");

    const [m] = await repo.listMessages("a", "i1");
    expect(m!.estado).toBe("fallido");
    expect(m!.externalId).toBeNull(); // nunca hubo recibo
    // El 404 del transporte se traduce a una causa clara en el registro
    // (el cuerpo crudo viaja en el Error lanzado; aquí queda la causa).
    expect(m!.errorCodigo).toBe("transporte_rechazo");
    expect(m!.error).toBeTruthy();
  });

  it("los pendientes sobreviven a un reinicio de la cola", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const repoA = repoNuevo();
    // El proceso A "muere" a mitad del envío de m1: su send nunca
    // resuelve. En disco quedan m1 `enviando` y m2 `encolado`.
    const colaA = new ColaEnvios({ dir, repo: repoA, intervaloMs: 60_000 });
    const colgado: MessageTransport = {
      connect: async () => {},
      disconnect: async () => {},
      getQr: async () => null,
      status: async () => "connected",
      numero: async () => null,
      send: () => new Promise(() => {}),
    };
    colaA.registrar("i1", colgado);
    await colaA.encolar(mensaje("m1"));
    await colaA.encolar(mensaje("m2"));
    await new Promise((r) => setTimeout(r, 100)); // deja arrancar m1
    colaA.baja("i1"); // "crash": el worker muere, el archivo queda

    const crudo = JSON.parse(readFileSync(join(dir, "i1.json"), "utf8"));
    expect(crudo).toHaveLength(2);

    // Proceso nuevo, repo nuevo: registra la instancia y recupera.
    const repoB = repoNuevo();
    const colaB = new ColaEnvios({
      dir,
      repo: repoB,
      intervaloMs: 30,
      jitterMaxMs: 5,
    });
    const falsoB = transporteFalso();
    colaB.registrar("i1", falsoB.transport);
    expect(colaB.pendientes("i1")).toBe(2);

    await esperarHasta(() => falsoB.envios.length === 2, 5000);
    colaB.baja("i1");
    expect(falsoB.envios.map((e) => e.cuerpo)).toEqual([
      "cuerpo m1",
      "cuerpo m2",
    ]);
  });

  it("baja con borrado descarta los pendientes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cauce-cola-"));
    const cola = new ColaEnvios({ dir, repo: repoNuevo(), intervaloMs: 60_000 });
    const { transport } = transporteFalso();
    cola.registrar("i1", transport);
    await cola.encolar(mensaje("m1"));
    cola.baja("i1", true);

    const colaB = new ColaEnvios({ dir, repo: repoNuevo() });
    colaB.registrar("i1", transport);
    expect(colaB.pendientes("i1")).toBe(0);
    colaB.baja("i1");
  });
});
