import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@cauce/core";
import { RepositorioEnMemoria } from "../../store.ts";
import { Cripto } from "../../cripto.ts";
import { usarSalida } from "../../log.ts";
import { ConectorOpenlines } from "./conector.ts";
import { chatExterno } from "./tipos.ts";

const AUTH = {
  access_token: "acc", refresh_token: "ref", expires_in: 3600,
  client_endpoint: "https://digsol.bitrix24.mx/rest/", domain: "digsol.bitrix24.mx",
  member_id: "m1", application_token: "apptok",
};

function armar(opciones: { rafagaN?: number; appInfoCode?: string; sinEventGet?: boolean; handlersPrevios?: string[] } = {}) {
  const repo = new RepositorioEnMemoria({
    tenants: [{
      id: "t1", nombre: "Digsol", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
      ...(opciones.rafagaN ? { canalAbierto: { rafagaN: opciones.rafagaN, rafagaSeg: 60, espaciadoMs: 0 } } : { canalAbierto: { espaciadoMs: 0 } }),
    }],
    instances: [{ id: "i1", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214428575347", estado: "connected", ultimoHeartbeat: null }],
  });
  const llamadas: { metodo: string; body: any }[] = [];
  // Portal simulado: recuerda los handlers enlazados, como Bitrix. Un
  // segundo event.bind del mismo handler falla con "Handler already binded".
  const enlazados = new Set<string>(opciones.handlersPrevios ?? []);
  const fetchImpl = (async (url: string, init: any) => {
    const metodo = url.split("/rest/")[1] ?? url;
    const body = init?.body ? JSON.parse(init.body) : null;
    llamadas.push({ metodo, body });
    if (metodo === "event.get") {
      if (opciones.sinEventGet) return new Response(JSON.stringify({ error: "INSUFFICIENT_SCOPE", error_description: "no" }), { status: 403 });
      return new Response(JSON.stringify({ result: [...enlazados].map((h) => ({ event: "ONIMCONNECTORMESSAGEADD", handler: h, auth_type: "0", offline: 0 })) }), { status: 200 });
    }
    if (metodo === "event.bind") {
      if (enlazados.has(body.handler)) return new Response(JSON.stringify({ error: "ERROR_CORE", error_description: "Handler already binded" }), { status: 400 });
      enlazados.add(body.handler);
      return new Response(JSON.stringify({ result: true }), { status: 200 });
    }
    if (metodo === "event.unbind") {
      enlazados.delete(body.handler);
      return new Response(JSON.stringify({ result: { count: 1 } }), { status: 200 });
    }
    if (metodo === "app.info") {
      // La app instalada es la nuestra: CODE = client_id dado de alta.
      return new Response(JSON.stringify({ result: { ID: 5, CODE: opciones.appInfoCode ?? "cid", VERSION: 1, STATUS: "L", INSTALLED: true } }), { status: 200 });
    }
    if (metodo === "imconnector.send.messages") {
      return new Response(JSON.stringify({ result: { SUCCESS: true, DATA: { RESULT: [{ session: { ID: "55", CHAT_ID: "901" } }] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const enviados: { telefono: string; cuerpo: string }[] = [];
  const encolados: Message[] = [];
  const cola = { encolar: async (m: Message) => { encolados.push(m); } } as any;
  const conector = new ConectorOpenlines({
    repo, cola, cripto: new Cripto(), urlPublica: "https://api.factory.digsol.com.mx", fetchImpl,
    dormir: async () => {},
    enviarInmediato: async (tenantId, instanceId, telefono, cuerpo) => {
      enviados.push({ telefono, cuerpo });
      return { id: `m-${enviados.length}`, tenantId, instanceId, direccion: "out", telefono, cuerpo, estado: "enviado", externalId: `ext-${enviados.length}`, timestamp: new Date().toISOString() };
    },
  });
  return { repo, conector, llamadas, enviados, encolados, enlazados };
}

/** Captura la bitácora durante una prueba. */
function capturarBitacora() {
  const lineas: string[] = [];
  usarSalida((_nivel, linea) => { lineas.push(linea); });
  return lineas;
}
afterEach(() => usarSalida(null));

async function instalarYActivar(c: ReturnType<typeof armar>) {
  await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "https://Digsol.bitrix24.mx/" });
  await c.conector.instalar("t1", AUTH);
  await c.conector.activar("t1", { line: 3, activo: true, memberId: "m1" });
}

const evento = (m: Partial<{ texto: string; userId: number; archivos: any[]; chat: string }> = {}) => ({
  CONNECTOR: "digsol_factory_t1", LINE: 3,
  MESSAGES: [{
    im: { chat_id: 901, message_id: 1234 },
    message: { text: m.texto ?? "Hola, ¿en qué te ayudo?", user_id: m.userId ?? 12, ...(m.archivos ? { files: m.archivos } : {}) },
    chat: { id: m.chat ?? chatExterno("i1", "5214428575347") },
  }],
});

describe("ConectorOpenlines", () => {
  it("alta → instalación registra el conector y el evento con el handler del tenant; los secretos quedan cifrados", async () => {
    const c = armar();
    await instalarYActivar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    expect(doc.activo).toBe(true);
    expect(doc.lineId).toBe(3);
    expect(doc.dominio).toBe("digsol.bitrix24.mx");
    expect(doc.appCifrada).not.toContain("sec");
    expect(doc.tokensCifrados).not.toContain("acc");
    const metodos = c.llamadas.map((l) => l.metodo);
    expect(metodos).toEqual(["app.info", "imconnector.register", "event.get", "event.bind", "imconnector.activate", "imconnector.connector.data.set"]);
    expect(doc.dominio).toBe("digsol.bitrix24.mx"); // normalizado desde la URL pegada
    expect(c.llamadas[1]!.body.PLACEMENT_HANDLER).toBe("https://api.factory.digsol.com.mx/bitrix/openlines/t1");
    expect(c.llamadas[3]!.body.handler).toBe("https://api.factory.digsol.com.mx/bitrix/openlines/t1");
  });

  it("IDEMPOTENCIA: reinstalar en el mismo portal no vuelve a enlazar el evento y no falla", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYActivar(c);
    c.llamadas.length = 0;
    await c.conector.instalar("t1", { ...AUTH, access_token: "acc2", refresh_token: "ref2" });
    const metodos = c.llamadas.map((l) => l.metodo);
    expect(metodos).toEqual(["app.info", "imconnector.register", "event.get"]);
    expect(c.enlazados.size).toBe(1);
    expect(bitacora.some((l) => l.includes("openlines.instalada") && l.includes("reinstalacion=true") && l.includes("evento=ya_enlazado"))).toBe(true);
    // Los tokens nuevos quedaron guardados y la instalación original se conserva
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    expect(doc.tokensCifrados).not.toBe("");
    expect(doc.lineId).toBe(3);
  });

  it("IDEMPOTENCIA: sin event.get, un 'Handler already binded' de event.bind se toma como estado deseado", async () => {
    const c = armar({ sinEventGet: true, handlersPrevios: ["https://api.factory.digsol.com.mx/bitrix/openlines/t1"] });
    await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "digsol.bitrix24.mx" });
    await expect(c.conector.instalar("t1", AUTH)).resolves.toBeUndefined();
    expect(c.llamadas.map((l) => l.metodo)).toEqual(["app.info", "imconnector.register", "event.get", "event.bind"]);
    expect((await c.repo.getOpenlinesBitrix("t1"))!.tokensCifrados).not.toBe("");
  });

  it("un handler viejo del mismo evento (otra URL pública) se desenlaza al instalar", async () => {
    const c = armar({ handlersPrevios: ["https://viejo.example/bitrix/openlines/t1"] });
    await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "digsol.bitrix24.mx" });
    await c.conector.instalar("t1", AUTH);
    expect(c.llamadas.map((l) => l.metodo)).toEqual(["app.info", "imconnector.register", "event.get", "event.unbind", "event.bind"]);
    expect([...c.enlazados]).toEqual(["https://api.factory.digsol.com.mx/bitrix/openlines/t1"]);
  });

  it("una instalación desde OTRO portal se rechaza", async () => {
    const c = armar();
    await instalarYActivar(c);
    await expect(c.conector.instalar("t1", { ...AUTH, member_id: "otro" })).rejects.toThrow(/otro portal/);
  });

  it("SEGURIDAD: un POST de instalación con tokens de un portal ajeno no secuestra el canal", async () => {
    const c = armar();
    await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "digsol.bitrix24.mx" });
    // Dominio distinto al declarado
    await expect(c.conector.instalar("t1", { ...AUTH, domain: "atacante.bitrix24.mx", client_endpoint: "https://atacante.bitrix24.mx/rest/" }))
      .rejects.toThrow(/no es el declarado/);
    // Dominio correcto pero endpoint apuntando a otro servidor
    await expect(c.conector.instalar("t1", { ...AUTH, client_endpoint: "https://servidor-malo.example/rest/" }))
      .rejects.toThrow(/client_endpoint no corresponde/);
    // Nada quedó instalado
    expect((await c.repo.getOpenlinesBitrix("t1"))!.tokensCifrados).toBe("");
    expect(c.llamadas.filter((l) => l.metodo === "imconnector.register")).toHaveLength(0);
  });

  it("SEGURIDAD: si app.info no devuelve nuestro client_id, la instalación se rechaza", async () => {
    const c = armar({ appInfoCode: "local.otraapp" });
    await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "digsol.bitrix24.mx" });
    await expect(c.conector.instalar("t1", AUTH)).rejects.toThrow(/no es de la aplicación local/);
    expect((await c.repo.getOpenlinesBitrix("t1"))!.tokensCifrados).toBe("");
  });

  it("SEGURIDAD: el placement sin member_id o con otro no toca la línea", async () => {
    const c = armar();
    await instalarYActivar(c);
    await expect(c.conector.activar("t1", { line: 9, activo: false, memberId: null })).rejects.toThrow(/no viene del portal/);
    await expect(c.conector.activar("t1", { line: 9, activo: false, memberId: "otro" })).rejects.toThrow(/no viene del portal/);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    expect(doc.lineId).toBe(3);
    expect(doc.activo).toBe(true);
  });

  it("entrante: manda a la línea con chat.id instancia:teléfono y guarda lo que Bitrix devolvió", async () => {
    const c = armar();
    await instalarYActivar(c);
    const msg: Message = { id: "in1", tenantId: "t1", instanceId: "i1", direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-09-12T10:00:00Z" };
    expect(await c.conector.entrante("t1", "i1", msg, "Mau")).toBe(true);
    const envio = c.llamadas.find((l) => l.metodo === "imconnector.send.messages")!;
    expect(envio.body.MESSAGES[0].chat.id).toBe("i1:5214428575347");
    expect(envio.body.MESSAGES[0].user).toMatchObject({ id: "5214428575347", name: "Mau", phone: "+5214428575347" });
    const conv = await c.repo.getConversacion("t1", "i1", "5214428575347");
    expect(conv?.bitrixOpenLine).toMatchObject({ lineId: 3, chatId: "901", sessionId: "55" });
  });

  it("entrante en otra instancia o con canal inactivo no hace nada, pero deja línea con el motivo", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYActivar(c);
    const msg: Message = { id: "in2", tenantId: "t1", instanceId: "OTRA", direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-09-12T10:00:00Z" };
    expect(await c.conector.entrante("t1", "OTRA", msg)).toBe(false);
    expect(bitacora.at(-1)).toMatch(/info openlines\.entrante .*resultado=omitido motivo="instancia distinta a la del canal"/);
    expect(c.llamadas.some((l) => l.metodo === "imconnector.send.messages")).toBe(false);
  });

  it("DIAGNÓSTICO: app instalada pero conector sin activar en ninguna línea abierta → línea warn, no silencio", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await c.conector.guardarAlta("t1", { instanceId: "i1", clientId: "cid", clientSecret: "sec", dominio: "digsol.bitrix24.mx" });
    const msg: Message = { id: "in3", tenantId: "t1", instanceId: "i1", direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-09-12T10:00:00Z" };
    expect(await c.conector.entrante("t1", "i1", msg)).toBe(false);
    expect(bitacora.at(-1)).toMatch(/warn openlines\.entrante .*motivo="app no instalada en el portal"/);
    await c.conector.instalar("t1", AUTH);
    expect(await c.conector.entrante("t1", "i1", msg)).toBe(false);
    expect(bitacora.at(-1)).toMatch(/warn openlines\.entrante .*telefono=\+521••••5347 .*motivo="conector sin activar en una línea abierta"/);
  });

  it("sin alta de canal abierto, entrante no registra nada (el tenant no lo usa)", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    const msg: Message = { id: "in4", tenantId: "t1", instanceId: "i1", direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-09-12T10:00:00Z" };
    expect(await c.conector.entrante("t1", "i1", msg)).toBe(false);
    expect(bitacora).toEqual([]);
  });

  it("operador: sale por el carril inmediato, confirma entrega a Bitrix y abre la ventana humana", async () => {
    const c = armar();
    await instalarYActivar(c);
    await c.conector.respuestaOperador("t1", evento());
    expect(c.enviados).toEqual([{ telefono: "+5214428575347", cuerpo: "Hola, ¿en qué te ayudo?" }]);
    const conf = c.llamadas.find((l) => l.metodo === "imconnector.send.status.delivery")!;
    expect(conf.body.MESSAGES[0]).toMatchObject({ im: { chat_id: 901, message_id: 1234 }, chat: { id: "i1:5214428575347" } });
    expect(conf.body.MESSAGES[0].message.id).toEqual(["ext-1"]);
    const conv = await c.repo.getConversacion("t1", "i1", "5214428575347");
    expect(conv?.humanaHasta && new Date(conv.humanaHasta) > new Date()).toBe(true);
    expect(ConectorOpenlines.enVentanaHumana(conv!)).toBe(true);
  });

  it("los mensajes del propio imbot NO se reenvían al contacto (sin rebote)", async () => {
    const c = armar();
    await instalarYActivar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, botId: 77 });
    await c.conector.respuestaOperador("t1", evento({ userId: 77, texto: "soy el bot" }));
    expect(c.enviados).toEqual([]);
  });

  it("solo texto en v1: un mensaje sin texto (adjunto) no se entrega ni se confirma", async () => {
    const c = armar();
    await instalarYActivar(c);
    await c.conector.respuestaOperador("t1", evento({ texto: "", archivos: [{ url: "https://p/f.jpg", name: "f.jpg" }] }));
    expect(c.enviados).toEqual([]);
    expect(c.llamadas.some((l) => l.metodo === "imconnector.send.status.delivery")).toBe(false);
  });

  it("tope de ráfaga por línea: el excedente va a la cola normal, no se descarta", async () => {
    const c = armar({ rafagaN: 2 });
    await instalarYActivar(c);
    for (let k = 0; k < 4; k += 1) await c.conector.respuestaOperador("t1", evento({ texto: `m${k}` }));
    expect(c.enviados.map((e) => e.cuerpo)).toEqual(["m0", "m1"]);
    expect(c.encolados.map((e) => e.cuerpo)).toEqual(["m2", "m3"]);
    expect(c.encolados[0]!.estado).toBe("encolado");
  });

  it("un evento de otro conector o línea se ignora", async () => {
    const c = armar();
    await instalarYActivar(c);
    await c.conector.respuestaOperador("t1", { ...evento(), LINE: 9 });
    expect(c.enviados).toEqual([]);
  });

  it("eventoAutentico compara el application_token del portal instalado", async () => {
    const c = armar();
    await instalarYActivar(c);
    expect(await c.conector.eventoAutentico("t1", { application_token: "apptok" })).toBe(true);
    expect(await c.conector.eventoAutentico("t1", { application_token: "otro" })).toBe(false);
    expect(await c.conector.eventoAutentico("t1", {})).toBe(false);
  });
});
