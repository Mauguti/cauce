import { afterEach, describe, expect, it } from "vitest";
import type { Message, Tenant } from "@cauce/core";
import { extraerAtribucion } from "../webhook.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { MotorEntrada } from "./motor.ts";
import type { ConectorBitrix } from "../bitrix/conector.ts";

const TENANT: Tenant = { id: "t1", nombre: "Digsol", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z" };

function payload(message: unknown) {
  return { event: "messages.upsert", data: { key: { remoteJid: "5215512345678@s.whatsapp.net", fromMe: false, id: "m1" }, messageType: "extendedTextMessage", message, messageTimestamp: 1757900000 } };
}

const entrante = (id = "in1"): Message =>
  ({ id, tenantId: "t1", instanceId: "A", direccion: "in", telefono: "+5215512345678", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: new Date().toISOString() });

afterEach(() => usarSalida(null));

describe("extraerAtribucion", () => {
  it("anuncio click-to-WhatsApp (externalAdReply): origen, sourceUrl con UTM y ctwaClid persistido", () => {
    const a = extraerAtribucion(payload({
      extendedTextMessage: {
        text: "Hola, vi su anuncio",
        contextInfo: { externalAdReply: { title: "Campaña Otoño", body: "20 % de descuento", sourceType: "ad", sourceId: "120210", sourceUrl: "https://fb.me/x?utm_source=facebook&utm_campaign=otono", ctwaClid: "AfB123" } },
      },
    }), new Date("2026-09-15T10:00:00Z"));
    expect(a.estado).toBe("atribuida");
    expect(a.origen).toBe("Anuncio click-to-WhatsApp (ad): Campaña Otoño · facebook · otono");
    expect(a.utm).toEqual({ utm_source: "facebook", utm_campaign: "otono" });
    expect(a.anuncio).toMatchObject({ titulo: "Campaña Otoño", ctwaClid: "AfB123", sourceId: "120210" });
    expect(a.capturadaEn).toBe("2026-09-15T10:00:00.000Z");
  });

  it("enlace con UTM en el texto, sin anuncio", () => {
    const a = extraerAtribucion(payload({ conversation: "Vengo de https://digsol.com.mx/promo?utm_source=instagram&utm_medium=bio&utm_campaign=sep" }));
    expect(a.estado).toBe("atribuida");
    expect(a.origen).toBe("instagram · bio · sep");
    expect(a.anuncio).toBeNull();
  });

  it("sin enlace ni anuncio: sin_atribuir explícito, nunca adivinado", () => {
    const a = extraerAtribucion(payload({ conversation: "hola, ¿precios?" }));
    expect(a).toMatchObject({ estado: "sin_atribuir", origen: null, utm: {}, anuncio: null });
  });

  it("un enlace sin parámetros de campaña no atribuye (se guarda la URL, nada más)", () => {
    const a = extraerAtribucion(payload({ conversation: "mira https://digsol.com.mx/" }));
    expect(a.estado).toBe("sin_atribuir");
    expect(a.url).toBe("https://digsol.com.mx/");
  });
});

describe("motor · atribución al primer contacto", () => {
  it("se guarda SOLO al primer contacto, se registra en bitácora y no se reescribe después", async () => {
    const repo = new RepositorioEnMemoria({ tenants: [TENANT], instances: [{ id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000001", estado: "connected", ultimoHeartbeat: null }] });
    const bitacora: string[] = [];
    usarSalida((_n, l) => { bitacora.push(l); });
    const motor = new MotorEntrada({ repo, enviarInmediato: async () => {} });
    const primera = extraerAtribucion(payload({ conversation: "https://x.mx/?utm_source=facebook&utm_campaign=otono" }));
    await motor.procesar("t1", "A", entrante("m1"), "Ana", primera);
    expect(bitacora.some((l) => l.includes("entrada.atribucion") && l.includes("estado=atribuida") && l.includes("otono"))).toBe(true);
    const conv1 = (await repo.getConversacion("t1", "A", "5215512345678"))!;
    expect(conv1.atribucion?.origen).toBe("facebook · otono");
    // Segundo mensaje con otro enlace: la atribución original se conserva
    const segunda = extraerAtribucion(payload({ conversation: "https://x.mx/?utm_source=google" }));
    await motor.procesar("t1", "A", entrante("m2"), "Ana", segunda);
    const conv2 = (await repo.getConversacion("t1", "A", "5215512345678"))!;
    expect(conv2.atribucion?.origen).toBe("facebook · otono");
    expect(bitacora.filter((l) => l.includes("entrada.atribucion"))).toHaveLength(1);
  });

  it("sin enlace queda 'sin atribuir' explícito y, si ya hay registro en el CRM, se escribe ahí", async () => {
    const repo = new RepositorioEnMemoria({ tenants: [TENANT], instances: [{ id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000001", estado: "connected", ultimoHeartbeat: null }] });
    usarSalida(() => {});
    const publicados: string[] = [];
    const bitrix = { publicarEnItem: async (_t: string, _e: string, _id: string, cuerpo: string) => { publicados.push(cuerpo); } } as unknown as ConectorBitrix;
    await repo.vincularBitrix("t1", "A", "5215512345678", "lead", "77"); // ya vinculada antes del primer mensaje
    const motor = new MotorEntrada({ repo, bitrix, enviarInmediato: async () => {} });
    await motor.procesar("t1", "A", entrante("m1"), null, extraerAtribucion(payload({ conversation: "hola" })));
    const conv = (await repo.getConversacion("t1", "A", "5215512345678"))!;
    expect(conv.atribucion?.estado).toBe("sin_atribuir");
    expect(publicados[0]).toBe("📣 Origen: sin atribuir");
  });
});
