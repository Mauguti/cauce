import { afterEach, describe, expect, it } from "vitest";
import type { Message, Tenant } from "@cauce/core";
import { esAdjuntoSinTexto, textoAdjuntoSinTexto } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { MotorEntrada } from "./motor.ts";
import type { DisparadorEntrada } from "./disparadores.ts";
import { Agente } from "../agentes/agente.ts";
import type { ProveedorModelo } from "../agentes/proveedor.ts";
import { normalizarEntrante } from "../webhook.ts";

/**
 * Un entrante con adjunto y sin texto (foto, audio, sticker…) es tráfico
 * real, pero no una pregunta: no dispara bots ni agente, no cuenta como
 * primer contacto y se espeja como adjunto, nunca como "📥 " vacío.
 */

const TENANT: Tenant = {
  id: "t1", nombre: "Taller", plan: "pro", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-01T00:00:00Z",
  agente: { activo: true, nombre: "Santiago", proveedor: "anthropic", modelo: "claude-opus-5" },
};
const BIENVENIDA: DisparadorEntrada = { id: "bienvenida", prioridad: 1, tipo: "primer_contacto", activo: true, respuesta: "¡Hola! Gracias por escribir." };
const PRECIO: DisparadorEntrada = { id: "precio", prioridad: 2, tipo: "palabra_clave", activo: true, patron: "precio", respuesta: "Aquí los precios." };
const TEL = "5215512345678";
let n = 0;
const msg = (cuerpo: string, tiposAdjunto?: Message["tiposAdjunto"]): Message => ({
  id: `m${++n}`, tenantId: "t1", instanceId: "A", direccion: "in", telefono: `+${TEL}`, cuerpo, estado: "recibido", externalId: null,
  timestamp: new Date(Date.parse("2026-10-12T15:00:00Z") + n * 60_000).toISOString(), ...(tiposAdjunto ? { tiposAdjunto } : {}),
});

function armar(opciones: { disparadores?: DisparadorEntrada[]; conAgente?: boolean } = {}) {
  const repo = new RepositorioEnMemoria({ tenants: [TENANT], instances: [{ id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000009", estado: "connected", ultimoHeartbeat: null }] });
  void repo.saveDisparadores("t1", opciones.disparadores ?? [BIENVENIDA, PRECIO]);
  const enviados: { cuerpo: string; origen?: string }[] = [];
  const publicados: { id: string; texto: string }[] = [];
  let llamadasAgente = 0;
  const proveedor: ProveedorModelo = {
    nombre: "anthropic",
    async responder() { llamadasAgente += 1; return { texto: "respuesta del agente", modelo: "claude-opus-5", uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 }, costoUsd: 0.0001, parada: "end_turn", herramientasUsadas: [] }; },
  };
  const bitrix = { publicarEnItem: async (_t: string, _tipo: string, id: string, texto: string) => { publicados.push({ id, texto }); } } as any;
  const motor = new MotorEntrada({
    repo, bitrix,
    ...(opciones.conAgente === false ? {} : { agente: new Agente({ repo, proveedores: { anthropic: proveedor } }) }),
    enviarInmediato: async (_t, _i, _tel, cuerpo, origen) => { enviados.push({ cuerpo, ...(origen ? { origen } : {}) }); },
  });
  const bitacora: string[] = [];
  usarSalida((_n, l) => { bitacora.push(l); });
  return { repo, motor, enviados, publicados, bitacora, llamadas: () => llamadasAgente };
}
afterEach(() => usarSalida(null));

describe("adjunto sin texto", () => {
  it("1 · no dispara bots ni agente, y la bitácora dice por qué", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", msg("", ["imagen"]), "Laura");
    expect(c.enviados).toEqual([]);
    expect(c.llamadas()).toBe(0);
    expect(c.bitacora.find((l) => l.includes("entrada.respuesta"))).toMatch(/resultado=ninguna origen="adjunto sin texto \(imagen\)/);
  });

  it("2 · un sticker a una conversación con historial no provoca bienvenida ni respuesta del agente", async () => {
    const c = armar();
    const texto = msg("hola, ¿tienen precio?");
    await c.motor.procesar("t1", "A", texto, "Laura");
    // Primer contacto real: bienvenida (primer disparador que coincide por prioridad).
    expect(c.enviados.map((e) => e.cuerpo)).toEqual(["¡Hola! Gracias por escribir."]);
    const sticker = msg("", ["sticker"]);
    await c.motor.procesar("t1", "A", sticker, "Laura");
    expect(c.enviados).toHaveLength(1);
    expect(c.llamadas()).toBe(0);
    const conv = (await c.repo.getConversacion("t1", "A", TEL))!;
    expect(conv.primerContactoEn).toBe(texto.timestamp);
    expect(conv.ultimoEntranteEn).toBe(sticker.timestamp);
  });

  it("2 · un sticker como PRIMER mensaje no consume el primer contacto: la bienvenida sale con el primer texto real", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", msg("", ["sticker"]), "Laura");
    expect(c.enviados).toEqual([]);
    const conv1 = (await c.repo.getConversacion("t1", "A", TEL))!;
    expect(conv1.primerContactoEn).toBeNull();
    expect(conv1.ultimoEntranteEn).not.toBeNull();
    const hola = msg("hola");
    await c.motor.procesar("t1", "A", hola, "Laura");
    expect(c.enviados.map((e) => e.cuerpo)).toEqual(["¡Hola! Gracias por escribir."]);
    expect((await c.repo.getConversacion("t1", "A", TEL))!.primerContactoEn).toBe(hola.timestamp);
  });

  it("3 · el espejo al CRM escribe el adjunto, nunca '📥 ' vacío", async () => {
    const c = armar();
    await c.repo.vincularBitrix("t1", "A", TEL, "deal", "77");
    await c.motor.procesar("t1", "A", msg("", ["imagen", "imagen", "audio"]), "Laura");
    expect(c.publicados).toEqual([{ id: "77", texto: "📎 Adjunto (imagen/audio) sin texto" }]);
    expect(c.publicados.some((p) => p.texto.trim() === "📥")).toBe(false);
  });

  it("un adjunto CON texto (caption) se comporta como hoy: dispara por palabra clave y se espeja como texto", async () => {
    const c = armar();
    await c.motor.procesar("t1", "A", msg("hola"), "Laura"); // consume la bienvenida
    await c.repo.vincularBitrix("t1", "A", TEL, "deal", "77");
    await c.motor.procesar("t1", "A", msg("¿cuál es el precio?", ["imagen"]), "Laura");
    expect(c.enviados.map((e) => e.cuerpo)).toEqual(["¡Hola! Gracias por escribir.", "Aquí los precios."]);
    expect(c.publicados.at(-1)).toEqual({ id: "77", texto: "📥 ¿cuál es el precio?" });
  });

  it("un cuerpo vacío SIN adjunto no es 'adjunto sin texto' (hoy no llega: el webhook lo descarta); los helpers lo distinguen", () => {
    expect(esAdjuntoSinTexto({ cuerpo: "", tiposAdjunto: ["audio"] })).toBe(true);
    expect(esAdjuntoSinTexto({ cuerpo: "   ", tiposAdjunto: ["imagen"] })).toBe(true);
    expect(esAdjuntoSinTexto({ cuerpo: "", tiposAdjunto: [] })).toBe(false);
    expect(esAdjuntoSinTexto({ cuerpo: "" })).toBe(false);
    expect(esAdjuntoSinTexto({ cuerpo: "hola", tiposAdjunto: ["imagen"] })).toBe(false);
    expect(textoAdjuntoSinTexto({ tiposAdjunto: ["nota de voz"] })).toBe("📎 Adjunto (nota de voz) sin texto");
  });

  it("el webhook de Evolution marca los tipos de adjunto del entrante", () => {
    const base = { event: "messages.upsert", instance: "x", data: { key: { remoteJid: "5215587654321@s.whatsapp.net", fromMe: false, id: "K1" }, pushName: "C", messageTimestamp: 1757100000 } };
    const foto = normalizarEntrante("t1", "A", { ...base, data: { ...base.data, message: { imageMessage: { mimetype: "image/jpeg" } } } })!;
    expect(foto.cuerpo).toBe("");
    expect(foto.tiposAdjunto).toEqual(["imagen"]);
    expect(esAdjuntoSinTexto(foto)).toBe(true);
    const nota = normalizarEntrante("t1", "A", { ...base, data: { ...base.data, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } } } })!;
    expect(nota.tiposAdjunto).toEqual(["nota de voz"]);
    const conCaption = normalizarEntrante("t1", "A", { ...base, data: { ...base.data, message: { imageMessage: { mimetype: "image/jpeg", caption: "mi comprobante" } } } })!;
    expect(conCaption.cuerpo).toBe("mi comprobante");
    expect(esAdjuntoSinTexto(conCaption)).toBe(false);
    const texto = normalizarEntrante("t1", "A", { ...base, data: { ...base.data, message: { conversation: "hola" } } })!;
    expect(texto.tiposAdjunto).toBeUndefined();
  });
});
