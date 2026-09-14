import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@cauce/core";
import { RepositorioEnMemoria } from "../../store.ts";
import { Cripto } from "../../cripto.ts";
import { usarSalida } from "../../log.ts";
import { ConectorOpenlines, ErrorConfirmacion } from "./conector.ts";
import { chatExterno, etiquetaLinea, formatearNumero, normalizarNombreLinea, normalizarOpenlinesDoc } from "./tipos.ts";

const AUTH = {
  access_token: "acc", refresh_token: "ref", expires_in: 3600,
  client_endpoint: "https://digsol.bitrix24.mx/rest/", domain: "digsol.bitrix24.mx",
  member_id: "m1", application_token: "apptok",
};

function armar(opciones: { rafagaN?: number; appInfoCode?: string; sinEventGet?: boolean; handlersPrevios?: string[]; fallaConfigAdd?: string; vivas?: string[] } = {}) {
  const repo = new RepositorioEnMemoria({
    tenants: [{
      id: "t1", nombre: "Digsol", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z",
      ...(opciones.rafagaN ? { canalAbierto: { rafagaN: opciones.rafagaN, rafagaSeg: 60, espaciadoMs: 0 } } : { canalAbierto: { espaciadoMs: 0 } }),
    }],
    instances: [
      { id: "i1", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214428575347", estado: "connected", ultimoHeartbeat: null },
      { id: "i2", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000002", estado: "qr", ultimoHeartbeat: null },
      { id: "i3", tenantId: "t1", transportType: "mock", contenedorId: null, numero: null, estado: "disconnected", ultimoHeartbeat: null },
    ],
  });
  const llamadas: { metodo: string; body: any }[] = [];
  // Portal simulado: recuerda los handlers enlazados, como Bitrix. Un
  // segundo event.bind del mismo handler falla con "Handler already binded".
  const enlazados = new Set<string>(opciones.handlersPrevios ?? []);
  const fetchImpl = (async (url: string, init: any) => {
    const metodo = url.split("/rest/")[1] ?? url;
    const body = init?.body ? JSON.parse(init.body) : null;
    llamadas.push({ metodo, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    if (metodo === "event.get") {
      if (opciones.sinEventGet) return new Response(JSON.stringify({ error: "INSUFFICIENT_SCOPE", error_description: "no" }), { status: 403 });
      return ok([...enlazados].map((h) => ({ event: "ONIMCONNECTORMESSAGEADD", handler: h, auth_type: "0", offline: 0 })));
    }
    if (metodo === "event.bind") {
      if (enlazados.has(body.handler)) return new Response(JSON.stringify({ error: "ERROR_CORE", error_description: "Handler already binded" }), { status: 400 });
      enlazados.add(body.handler);
      return ok(true);
    }
    if (metodo === "event.unbind") { enlazados.delete(body.handler); return ok({ count: 1 }); }
    if (metodo === "app.info") return ok({ ID: 5, CODE: opciones.appInfoCode ?? "cid", VERSION: 1, STATUS: "L", INSTALLED: true });
    if (metodo === "imconnector.send.messages") return ok({ SUCCESS: true, DATA: { RESULT: [{ session: { ID: "55", CHAT_ID: "901" } }] } });
    if (metodo === "imopenlines.config.list.get") return ok([{ ID: "3", LINE_NAME: "Ventas", ACTIVE: "Y" }, { ID: "7", LINE_NAME: "Soporte", ACTIVE: "Y" }]);
    if (metodo === "profile") return ok({ ID: "1", ADMIN: true });
    if (metodo === "imopenlines.config.add") {
      if (opciones.fallaConfigAdd) return new Response(JSON.stringify({ error: "ERROR", error_description: opciones.fallaConfigAdd }), { status: 400 });
      return ok(9);
    }
    if (metodo === "imopenlines.config.path.get") return ok({ SERVER_ADDRESS: "https://digsol.bitrix24.mx", PUBLIC_PATH: "/contact_center/" });
    return ok(true);
  }) as unknown as typeof fetch;
  const enviados: { instanceId: string; telefono: string; cuerpo: string }[] = [];
  const encolados: Message[] = [];
  const cola = { encolar: async (m: Message) => { encolados.push(m); } } as any;
  const vivas = new Set(opciones.vivas ?? ["i1", "i2"]);
  const conector = new ConectorOpenlines({
    repo, cola, cripto: new Cripto(), urlPublica: "https://api.factory.digsol.com.mx", fetchImpl,
    dormir: async () => {},
    sesionViva: (i) => vivas.has(i),
    enviarInmediato: async (tenantId, instanceId, telefono, cuerpo) => {
      enviados.push({ instanceId, telefono, cuerpo });
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

const ALTA = { clientId: "cid", clientSecret: "sec", dominio: "https://Digsol.bitrix24.mx/" };

async function instalar(c: ReturnType<typeof armar>) {
  await c.conector.guardarAlta("t1", ALTA);
  await c.conector.instalar("t1", AUTH);
}

async function instalarYAsignar(c: ReturnType<typeof armar>) {
  await instalar(c);
  await c.conector.asignar("t1", "i1", 3);
}

const evento = (m: Partial<{ texto: string; userId: number; archivos: any[]; chat: string; line: number }> = {}) => ({
  CONNECTOR: "digsol_factory_t1", LINE: m.line ?? 3,
  MESSAGES: [{
    im: { chat_id: 901, message_id: 1234 },
    message: { text: m.texto ?? "Hola, ¿en qué te ayudo?", user_id: m.userId ?? 12, ...(m.archivos ? { files: m.archivos } : {}) },
    chat: { id: m.chat ?? chatExterno("i1", "5214428575347") },
  }],
});

const entrante = (instanceId: string, id = "in1"): Message =>
  ({ id, tenantId: "t1", instanceId, direccion: "in", telefono: "+5214428575347", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-09-12T10:00:00Z" });

describe("ConectorOpenlines · instalación", () => {
  it("alta → instalación registra el conector y el evento con el handler del tenant; los secretos quedan cifrados", async () => {
    const c = armar();
    await instalar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    expect(doc.dominio).toBe("digsol.bitrix24.mx"); // normalizado desde la URL pegada
    expect(doc.appCifrada).not.toContain("sec");
    expect(doc.tokensCifrados).not.toContain("acc");
    expect(doc.asignaciones).toEqual({});
    const metodos = c.llamadas.map((l) => l.metodo);
    expect(metodos).toEqual(["app.info", "imconnector.register", "event.get", "event.bind"]);
    expect(c.llamadas[1]!.body.PLACEMENT_HANDLER).toBe("https://api.factory.digsol.com.mx/bitrix/openlines/t1");
    expect(c.llamadas[3]!.body.handler).toBe("https://api.factory.digsol.com.mx/bitrix/openlines/t1");
  });

  it("IDEMPOTENCIA: reinstalar en el mismo portal no vuelve a enlazar el evento, no falla y conserva las asignaciones", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    c.llamadas.length = 0;
    await c.conector.instalar("t1", { ...AUTH, access_token: "acc2", refresh_token: "ref2" });
    expect(c.llamadas.map((l) => l.metodo)).toEqual(["app.info", "imconnector.register", "event.get"]);
    expect(c.enlazados.size).toBe(1);
    expect(bitacora.some((l) => l.includes("openlines.instalada") && l.includes("reinstalacion=true") && l.includes("evento=ya_enlazado"))).toBe(true);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    expect(doc.tokensCifrados).not.toBe("");
    expect(doc.asignaciones.i1?.lineId).toBe(3);
  });

  it("IDEMPOTENCIA: sin event.get, un 'Handler already binded' de event.bind se toma como estado deseado", async () => {
    const c = armar({ sinEventGet: true, handlersPrevios: ["https://api.factory.digsol.com.mx/bitrix/openlines/t1"] });
    await c.conector.guardarAlta("t1", ALTA);
    await expect(c.conector.instalar("t1", AUTH)).resolves.toBeUndefined();
    expect(c.llamadas.map((l) => l.metodo)).toEqual(["app.info", "imconnector.register", "event.get", "event.bind"]);
  });

  it("un handler viejo del mismo evento (otra URL pública) se desenlaza al instalar", async () => {
    const c = armar({ handlersPrevios: ["https://viejo.example/bitrix/openlines/t1"] });
    await instalar(c);
    expect(c.llamadas.map((l) => l.metodo)).toEqual(["app.info", "imconnector.register", "event.get", "event.unbind", "event.bind"]);
    expect([...c.enlazados]).toEqual(["https://api.factory.digsol.com.mx/bitrix/openlines/t1"]);
  });

  it("una instalación desde OTRO portal se rechaza", async () => {
    const c = armar();
    await instalar(c);
    await expect(c.conector.instalar("t1", { ...AUTH, member_id: "otro" })).rejects.toThrow(/otro portal/);
  });

  it("SEGURIDAD: un POST de instalación con tokens de un portal ajeno no secuestra el canal", async () => {
    const c = armar();
    await c.conector.guardarAlta("t1", ALTA);
    await expect(c.conector.instalar("t1", { ...AUTH, domain: "atacante.bitrix24.mx", client_endpoint: "https://atacante.bitrix24.mx/rest/" }))
      .rejects.toThrow(/no es el declarado/);
    await expect(c.conector.instalar("t1", { ...AUTH, client_endpoint: "https://servidor-malo.example/rest/" }))
      .rejects.toThrow(/client_endpoint no corresponde/);
    expect((await c.repo.getOpenlinesBitrix("t1"))!.tokensCifrados).toBe("");
    expect(c.llamadas.filter((l) => l.metodo === "imconnector.register")).toHaveLength(0);
  });

  it("SEGURIDAD: si app.info no devuelve nuestro client_id, la instalación se rechaza", async () => {
    const c = armar({ appInfoCode: "local.otraapp" });
    await c.conector.guardarAlta("t1", ALTA);
    await expect(c.conector.instalar("t1", AUTH)).rejects.toThrow(/no es de la aplicación local/);
    expect((await c.repo.getOpenlinesBitrix("t1"))!.tokensCifrados).toBe("");
  });

  it("MIGRACIÓN: un documento con la forma vieja (instanceId/lineId/activo) se lee como una asignación", async () => {
    const c = armar();
    await instalar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, instanceId: "i1", lineId: 12, activo: true } as any);
    const vista = (await c.conector.ver("t1"))!;
    expect(vista.asignaciones).toEqual([{ instanceId: "i1", lineId: 12, asignadaEn: doc.actualizadoEn }]);
    // Inactivo o sin línea no cuenta
    expect(normalizarOpenlinesDoc({ ...doc, instanceId: "i1", lineId: 12, activo: false } as any)!.asignaciones).toEqual({});
    expect(normalizarOpenlinesDoc({ ...doc, instanceId: "i1", lineId: null, activo: true } as any)!.asignaciones).toEqual({});
  });
});

describe("ConectorOpenlines · líneas y asignaciones", () => {
  it("lineas(): todas las instancias con estado real y línea abierta, en una lectura; nombres de Bitrix cuando la app está instalada", async () => {
    const c = armar();
    await instalarYAsignar(c);
    const r = await c.conector.lineas("t1");
    expect(r.lineasAbiertasError).toBeNull();
    expect(r.lineas).toEqual([
      expect.objectContaining({ instanceId: "i1", numero: "+5214428575347", estado: "connected", viva: true, lineId: 3, lineaNombre: "Ventas" }),
      expect.objectContaining({ instanceId: "i2", estado: "qr", viva: true, lineId: null, lineaNombre: null }),
      expect.objectContaining({ instanceId: "i3", numero: null, estado: "disconnected", viva: false, lineId: null }),
    ]);
    expect(c.llamadas.filter((l) => l.metodo === "imopenlines.config.list.get")).toHaveLength(1);
  });

  it("lineasAbiertas(): las del portal con los números que ya las atienden", async () => {
    const c = armar();
    await instalarYAsignar(c);
    const lineas = await c.conector.lineasAbiertas("t1");
    expect(lineas).toEqual([
      { id: 3, nombre: "Ventas", activa: true, numeros: [{ instanceId: "i1", numero: "+5214428575347" }] },
      { id: 7, nombre: "Soporte", activa: true, numeros: [] },
    ]);
  });

  it("asignar: activa el conector en la línea y describe el canal con el número; queda en el documento", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    const activar = c.llamadas.find((l) => l.metodo === "imconnector.activate")!;
    expect(activar.body).toMatchObject({ CONNECTOR: "digsol_factory_t1", LINE: 3, ACTIVE: 1 });
    const datos = c.llamadas.find((l) => l.metodo === "imconnector.connector.data.set")!;
    expect(datos.body).toMatchObject({ LINE: 3, DATA: { ID: "i1", NAME: "WhatsApp · Digsol Factory · +521 442 857 5347" } });
    expect((await c.conector.ver("t1"))!.asignaciones).toEqual([expect.objectContaining({ instanceId: "i1", lineId: 3 })]);
    expect(bitacora.some((l) => l.includes("openlines.asignacion") && l.includes("resultado=asignada") && l.includes("linea=3"))).toBe(true);
  });

  it("asignar la misma línea otra vez no cambia nada y no exige confirmación", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await expect(c.conector.asignar("t1", "i1", 3)).resolves.toBeDefined();
    expect((await c.conector.ver("t1"))!.asignaciones).toHaveLength(1);
  });

  it("REASIGNAR: mover un número a otra línea exige confirmación; al confirmar, la línea anterior vacía se desactiva", async () => {
    const c = armar();
    await instalarYAsignar(c);
    let err: unknown;
    try { await c.conector.asignar("t1", "i1", 7); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ErrorConfirmacion);
    expect((err as ErrorConfirmacion).tipo).toBe("reasignacion");
    expect((err as ErrorConfirmacion).detalle).toEqual({ lineaActual: 3 });
    expect((await c.conector.ver("t1"))!.asignaciones[0]!.lineId).toBe(3); // nada cambió
    c.llamadas.length = 0;
    await c.conector.asignar("t1", "i1", 7, { reasignacion: true });
    const activaciones = c.llamadas.filter((l) => l.metodo === "imconnector.activate").map((l) => [l.body.LINE, l.body.ACTIVE]);
    expect(activaciones).toEqual([[7, 1], [3, 0]]);
    expect((await c.conector.ver("t1"))!.asignaciones).toEqual([expect.objectContaining({ instanceId: "i1", lineId: 7 })]);
  });

  it("COMPARTIR: sumar un número a una línea que ya tiene otro exige confirmación y muestra cuáles; al confirmar, el canal lista ambos", async () => {
    const c = armar();
    await instalarYAsignar(c);
    let err: unknown;
    try { await c.conector.asignar("t1", "i2", 3); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ErrorConfirmacion);
    expect((err as ErrorConfirmacion).tipo).toBe("compartida");
    expect((err as ErrorConfirmacion).detalle).toEqual({ numeros: ["+521 442 857 5347"] });
    c.llamadas.length = 0;
    await c.conector.asignar("t1", "i2", 3, { compartida: true });
    const datos = c.llamadas.find((l) => l.metodo === "imconnector.connector.data.set")!;
    expect(datos.body.DATA).toEqual({ ID: "i1,i2", NAME: "WhatsApp · Digsol Factory · +521 442 857 5347, +521 442 000 0002" });
    const lineas = await c.conector.lineasAbiertas("t1");
    expect(lineas[0]!.numeros.map((n) => n.instanceId)).toEqual(["i1", "i2"]);
  });

  it("reasignar desde una línea compartida deja la línea anterior con los que quedan, sin desactivarla", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await c.conector.asignar("t1", "i2", 3, { compartida: true });
    c.llamadas.length = 0;
    await c.conector.asignar("t1", "i1", 7, { reasignacion: true });
    expect(c.llamadas.filter((l) => l.metodo === "imconnector.activate").map((l) => [l.body.LINE, l.body.ACTIVE])).toEqual([[7, 1]]);
    const redescrita = c.llamadas.filter((l) => l.metodo === "imconnector.connector.data.set").find((l) => l.body.LINE === 3)!;
    expect(redescrita.body.DATA.ID).toBe("i2");
  });

  it("desasignar: la línea queda vacía y se desactiva", async () => {
    const c = armar();
    await instalarYAsignar(c);
    c.llamadas.length = 0;
    await c.conector.desasignar("t1", "i1");
    expect(c.llamadas.map((l) => [l.metodo, l.body?.LINE, l.body?.ACTIVE])).toEqual([["imconnector.activate", 3, 0]]);
    expect((await c.conector.ver("t1"))!.asignaciones).toEqual([]);
  });

  it("asignar exige app instalada, línea válida e instancia del tenant", async () => {
    const c = armar();
    await c.conector.guardarAlta("t1", ALTA);
    await expect(c.conector.asignar("t1", "i1", 3)).rejects.toThrow(/aún no se ha instalado/);
    await c.conector.instalar("t1", AUTH);
    await expect(c.conector.asignar("t1", "i1", 0)).rejects.toThrow(/línea abierta inválida/);
    await expect(c.conector.asignar("t1", "no-existe", 3)).rejects.toThrow(/no encontrada/);
  });

  it("crearLineaAbierta: explícita, activa, con el usuario de la app como operador, y devuelve el enlace al Contact Center", async () => {
    const c = armar();
    await instalar(c);
    const r = await c.conector.crearLineaAbierta("t1", "  WhatsApp Ventas ");
    expect(r).toEqual({ id: 9, nombre: "WhatsApp Ventas", urlContactCenter: "https://digsol.bitrix24.mx/contact_center/" });
    const add = c.llamadas.find((l) => l.metodo === "imopenlines.config.add")!;
    expect(add.body.PARAMS).toEqual({ LINE_NAME: "WhatsApp Ventas", ACTIVE: "Y", QUEUE: [1] });
    // NUNCA por default: asignar a una línea existente no crea nada
    expect(c.llamadas.filter((l) => l.metodo === "imopenlines.config.add")).toHaveLength(1);
  });

  it("crearLineaAbierta: el error crudo de Bitrix se conserva y se explica el tope por plan", async () => {
    const c = armar({ fallaConfigAdd: "Limit of open lines reached" });
    await instalar(c);
    await expect(c.conector.crearLineaAbierta("t1", "Otra")).rejects.toThrow(/Limit of open lines reached.*Free 1 · Basic 2 · Standard 10/);
  });
});

describe("ConectorOpenlines · placement", () => {
  it("la página lista los números con estado, quién atiende qué, y el token autentica el POST de vuelta", async () => {
    const c = armar();
    await instalarYAsignar(c);
    const p = await c.conector.paginaPlacement("t1", { line: 7, memberId: "m1" });
    expect(p.status).toBe(200);
    expect(p.html).toContain("Línea abierta 7 · Soporte · sin número asignado");
    expect(p.html).toContain("+521 442 857 5347");
    expect(p.html).toContain("ya atiende la línea abierta 3");
    expect(p.html).toContain("Sin vincular: pide escanear el QR");
    expect(p.html).toContain("Desconectada");
    expect(p.html).toContain("Sin número todavía");
    expect(p.html).not.toContain("<script");
    const token = /name="token" value="([^"]+)"/.exec(p.html)![1]!;

    // Elegir i2 (libre) → conectado
    const r = await c.conector.asignarDesdePlacement("t1", { token, instanceId: "i2", confirmarReasignacion: false, confirmarCompartida: false });
    expect(r.status).toBe(200);
    expect(r.html).toContain("Conectado en la línea abierta 7 · +521 442 000 0002");
    expect(r.html).toContain("Instancia i2");
    expect((await c.conector.ver("t1"))!.asignaciones).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: "i2", lineId: 7 })]));
  });

  it("reasignar desde el placement pide confirmación en la misma página y luego la acepta", async () => {
    const c = armar();
    await instalarYAsignar(c);
    const p = await c.conector.paginaPlacement("t1", { line: 7, memberId: "m1" });
    const token = /name="token" value="([^"]+)"/.exec(p.html)![1]!;
    const r1 = await c.conector.asignarDesdePlacement("t1", { token, instanceId: "i1", confirmarReasignacion: false, confirmarCompartida: false });
    expect(r1.html).toContain("ya atiende la línea abierta 3");
    expect(r1.html).toContain('name="confirmar_reasignacion"');
    expect((await c.conector.ver("t1"))!.asignaciones[0]!.lineId).toBe(3);
    const r2 = await c.conector.asignarDesdePlacement("t1", { token, instanceId: "i1", confirmarReasignacion: true, confirmarCompartida: false });
    expect(r2.html).toContain("Conectado en la línea abierta 7");
    expect((await c.conector.ver("t1"))!.asignaciones).toEqual([expect.objectContaining({ instanceId: "i1", lineId: 7 })]);
  });

  it("SEGURIDAD: el placement sin member_id o con otro no muestra nada ni toca la línea; un token ajeno o vencido se rechaza", async () => {
    const c = armar();
    await instalarYAsignar(c);
    expect((await c.conector.paginaPlacement("t1", { line: 9, memberId: null })).status).toBe(403);
    expect((await c.conector.paginaPlacement("t1", { line: 9, memberId: "otro" })).status).toBe(403);
    const r = await c.conector.asignarDesdePlacement("t1", { token: "basura", instanceId: "i1", confirmarReasignacion: true, confirmarCompartida: true });
    expect(r.status).toBe(403);
    expect((await c.conector.ver("t1"))!.asignaciones[0]!.lineId).toBe(3);
  });
});

describe("ConectorOpenlines · mensajes", () => {
  it("entrante: va a la línea abierta que atiende el número, con chat.id instancia:teléfono, y guarda lo que Bitrix devolvió", async () => {
    const c = armar();
    await instalarYAsignar(c);
    expect(await c.conector.entrante("t1", "i1", entrante("i1"), "Mau")).toBe(true);
    const envio = c.llamadas.find((l) => l.metodo === "imconnector.send.messages")!;
    expect(envio.body.LINE).toBe(3);
    expect(envio.body.MESSAGES[0].chat.id).toBe("i1:5214428575347");
    expect(envio.body.MESSAGES[0].user).toMatchObject({ id: "5214428575347", name: "Mau", phone: "+5214428575347" });
    const conv = await c.repo.getConversacion("t1", "i1", "5214428575347");
    expect(conv?.bitrixOpenLine).toMatchObject({ lineId: 3, chatId: "901", sessionId: "55" });
  });

  it("entrante de un número sin línea asignada no se manda, pero deja línea con el motivo", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    expect(await c.conector.entrante("t1", "i2", entrante("i2", "in2"))).toBe(false);
    expect(bitacora.at(-1)).toMatch(/warn openlines\.entrante .*resultado=omitido motivo="número sin línea abierta asignada"/);
    expect(c.llamadas.some((l) => l.metodo === "imconnector.send.messages")).toBe(false);
  });

  it("DIAGNÓSTICO: app dada de alta pero no instalada → línea warn, no silencio; sin alta → nada", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    expect(await c.conector.entrante("t1", "i1", entrante("i1", "in3"))).toBe(false);
    expect(bitacora).toEqual([]);
    await c.conector.guardarAlta("t1", ALTA);
    expect(await c.conector.entrante("t1", "i1", entrante("i1", "in3"))).toBe(false);
    expect(bitacora.at(-1)).toMatch(/warn openlines\.entrante .*telefono=\+521••••5347 .*motivo="app no instalada en el portal"/);
  });

  it("dos números en una línea compartida: cada entrante llega con su propio chat y la respuesta sale por el número correcto", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await c.conector.asignar("t1", "i2", 3, { compartida: true });
    await c.conector.entrante("t1", "i2", entrante("i2", "in9"));
    const envio = c.llamadas.filter((l) => l.metodo === "imconnector.send.messages").at(-1)!;
    expect(envio.body.LINE).toBe(3);
    expect(envio.body.MESSAGES[0].chat.id).toBe("i2:5214428575347");
    await c.conector.respuestaOperador("t1", evento({ chat: chatExterno("i2", "5214428575347"), texto: "desde soporte" }));
    expect(c.enviados).toEqual([{ instanceId: "i2", telefono: "+5214428575347", cuerpo: "desde soporte" }]);
  });

  it("operador: sale por el carril inmediato, confirma entrega a Bitrix y abre la ventana humana", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await c.conector.respuestaOperador("t1", evento());
    expect(c.enviados).toEqual([{ instanceId: "i1", telefono: "+5214428575347", cuerpo: "Hola, ¿en qué te ayudo?" }]);
    const conf = c.llamadas.find((l) => l.metodo === "imconnector.send.status.delivery")!;
    expect(conf.body.MESSAGES[0]).toMatchObject({ im: { chat_id: 901, message_id: 1234 }, chat: { id: "i1:5214428575347" } });
    expect(conf.body.MESSAGES[0].message.id).toEqual(["ext-1"]);
    const conv = await c.repo.getConversacion("t1", "i1", "5214428575347");
    expect(ConectorOpenlines.enVentanaHumana(conv!)).toBe(true);
  });

  it("operador: un chat de un número sin asignación se ignora con motivo", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    await c.conector.respuestaOperador("t1", evento({ chat: chatExterno("i3", "5214428575347") }));
    expect(c.enviados).toEqual([]);
    expect(bitacora.at(-1)).toMatch(/motivo="número sin línea abierta asignada"/);
  });

  it("los mensajes del propio imbot NO se reenvían al contacto (sin rebote)", async () => {
    const c = armar();
    await instalarYAsignar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, botId: 77 });
    await c.conector.respuestaOperador("t1", evento({ userId: 77, texto: "soy el bot" }));
    expect(c.enviados).toEqual([]);
  });

  it("solo texto en v1: un mensaje sin texto (adjunto) no se entrega ni se confirma", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await c.conector.respuestaOperador("t1", evento({ texto: "", archivos: [{ url: "https://p/f.jpg", name: "f.jpg" }] }));
    expect(c.enviados).toEqual([]);
    expect(c.llamadas.some((l) => l.metodo === "imconnector.send.status.delivery")).toBe(false);
  });

  it("tope de ráfaga por número: el excedente va a la cola normal, no se descarta", async () => {
    const c = armar({ rafagaN: 2 });
    await instalarYAsignar(c);
    for (let k = 0; k < 4; k += 1) await c.conector.respuestaOperador("t1", evento({ texto: `m${k}` }));
    expect(c.enviados.map((e) => e.cuerpo)).toEqual(["m0", "m1"]);
    expect(c.encolados.map((e) => e.cuerpo)).toEqual(["m2", "m3"]);
    expect(c.encolados[0]!.estado).toBe("encolado");
  });

  it("un evento de otro conector se ignora", async () => {
    const c = armar();
    await instalarYAsignar(c);
    await c.conector.respuestaOperador("t1", { ...evento(), CONNECTOR: "otro" });
    expect(c.enviados).toEqual([]);
  });

  it("eventoAutentico compara el application_token del portal instalado", async () => {
    const c = armar();
    await instalarYAsignar(c);
    expect(await c.conector.eventoAutentico("t1", { application_token: "apptok" })).toBe(true);
    expect(await c.conector.eventoAutentico("t1", { application_token: "otro" })).toBe(false);
    expect(await c.conector.eventoAutentico("t1", {})).toBe(false);
  });
});

describe("nombre por línea", () => {
  it("con nombre, Bitrix, el placement, la confirmación y la bitácora lo usan; el número queda al lado para soporte", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalar(c);
    const i1 = (await c.repo.getInstance("t1", "i1"))!;
    await c.repo.saveInstance({ ...i1, nombre: "Ventas Norte" });
    await c.conector.asignar("t1", "i1", 3);
    const datos = c.llamadas.find((l) => l.metodo === "imconnector.connector.data.set")!;
    expect(datos.body.DATA.NAME).toBe("WhatsApp · Digsol Factory · Ventas Norte (+521 442 857 5347)");
    expect(bitacora.some((l) => l.includes("openlines.asignacion") && l.includes('nombre="Ventas Norte"') && l.includes("instancia=i1"))).toBe(true);
    expect((await c.conector.lineas("t1")).lineas[0]).toMatchObject({ instanceId: "i1", nombre: "Ventas Norte", numero: "+5214428575347" });

    const p = await c.conector.paginaPlacement("t1", { line: 7, memberId: "m1" });
    expect(p.html).toContain('<div class="num">Ventas Norte<span class="ya">ya atiende la línea abierta 3</span></div>');
    expect(p.html).toContain('<div class="meta">+521 442 857 5347</div>');
    const token = /name="token" value="([^"]+)"/.exec(p.html)![1]!;
    const r = await c.conector.asignarDesdePlacement("t1", { token, instanceId: "i1", confirmarReasignacion: true, confirmarCompartida: false });
    expect(r.html).toContain("Conectado en la línea abierta 7 · Ventas Norte (+521 442 857 5347)");

    await c.conector.entrante("t1", "i1", entrante("i1", "in-n"));
    expect(bitacora.at(-1)).toMatch(/openlines\.entrante .*instancia=i1 nombre="Ventas Norte" .*resultado=ok/);
  });

  it("sin nombre cae al número; sin número, al id. Nunca vacío. El nombre se normaliza y se acota", () => {
    expect(etiquetaLinea({ id: "i1", numero: "+5214428575347", nombre: "Ventas Norte" })).toBe("Ventas Norte (+521 442 857 5347)");
    expect(etiquetaLinea({ id: "i1", numero: "+5214428575347", nombre: null })).toBe("+521 442 857 5347");
    expect(etiquetaLinea({ id: "i1", numero: "+5214428575347" })).toBe("+521 442 857 5347");
    expect(etiquetaLinea({ id: "i1", numero: null, nombre: "  " })).toBe("i1");
    expect(normalizarNombreLinea("  Ventas   Norte \n")).toBe("Ventas Norte");
    expect(normalizarNombreLinea("")).toBeNull();
    expect(normalizarNombreLinea(42)).toBeNull();
    expect(normalizarNombreLinea("x".repeat(60))!.length).toBe(40);
  });
});

describe("reflejo del bot en el chat del operador", () => {
  it("usa imopenlines.bot.session.message.send con CHAT_ID numérico y, si falla, imbot.message.add con chatNN; la bitácora dice cuál", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, botId: 324 });
    await c.conector.entrante("t1", "i1", entrante("i1", "in-b")); // vincula chatBitrix 901
    await c.conector.reflejarBot("t1", "i1", "+5214428575347", "hola desde el bot");
    const sesion = c.llamadas.find((l) => l.metodo === "imopenlines.bot.session.message.send")!;
    expect(sesion.body).toMatchObject({ CHAT_ID: 901, NAME: "DEFAULT", MESSAGE: "🤖 hola desde el bot" });
    expect(c.llamadas.some((l) => l.metodo === "imbot.message.add")).toBe(false);
    expect(bitacora.at(-1)).toMatch(/openlines\.bot_reflejado .*metodo=imopenlines\.bot\.session\.message\.send/);
  });
});

describe("eco del reflejo", () => {
  it("PRIMARIO: un evento con usuario=0 es eco (journal 15-sep), no se reenvía, no se confirma y NO fija la ventana humana", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, botId: 324 });
    await c.conector.entrante("t1", "i1", entrante("i1", "in-eco0"));
    await c.conector.reflejarBot("t1", "i1", "+5214428575347", "Respuesta del agente");
    // El eco llega con un texto DISTINTO al recordado (Bitrix lo recortó): solo usuario=0 lo delata
    await c.conector.respuestaOperador("t1", evento({ userId: 0, texto: "Respuesta del agente (recortada por Bitrix)" }));
    expect(c.enviados).toEqual([]);
    expect(c.llamadas.some((l) => l.metodo === "imconnector.send.status.delivery")).toBe(false);
    expect(bitacora.at(-1)).toMatch(/motivo="eco del reflejo del bot \(usuario=0\)"/);
    // CRITERIO: tras una respuesta del agente reflejada, la conversación NO queda en ventana humana
    const conv = (await c.repo.getConversacion("t1", "i1", "5214428575347"))!;
    expect(conv.humanaHasta ?? null).toBeNull();
    expect(ConectorOpenlines.enVentanaHumana(conv)).toBe(false);
  });

  it("RESPALDO: lo que escribimos como bot y vuelve con otro user_id NO se reenvía al contacto", async () => {
    const c = armar();
    const bitacora = capturarBitacora();
    await instalarYAsignar(c);
    const doc = (await c.repo.getOpenlinesBitrix("t1"))!;
    await c.repo.saveOpenlinesBitrix("t1", { ...doc, botId: 324 });
    await c.conector.entrante("t1", "i1", entrante("i1", "in-eco"));
    await c.conector.reflejarBot("t1", "i1", "+5214428575347", "Con gusto te explico el plan Estándar.");
    // Bitrix nos devuelve ese mismo texto como si fuera de un operador (user_id distinto al bot), con y sin prefijo
    await c.conector.respuestaOperador("t1", evento({ userId: 999, texto: "🤖 Con gusto te explico el plan Estándar." }));
    await c.conector.respuestaOperador("t1", evento({ userId: 999, texto: "Con gusto te explico el plan Estándar." }));
    expect(c.enviados).toEqual([]);
    expect(bitacora.filter((l) => l.includes('motivo="eco del reflejo del bot"'))).toHaveLength(2);
    // Un operador de verdad sí pasa, y solo entonces se abre la ventana humana
    await c.conector.respuestaOperador("t1", evento({ userId: 999, texto: "Soy Mau, ¿te ayudo?" }));
    expect(c.enviados).toHaveLength(1);
    expect(ConectorOpenlines.enVentanaHumana((await c.repo.getConversacion("t1", "i1", "5214428575347"))!)).toBe(true);
  });
});

describe("formatearNumero", () => {
  it("agrupa a la mexicana con o sin el 1 de WhatsApp", () => {
    expect(formatearNumero("+5214428575347")).toBe("+521 442 857 5347");
    expect(formatearNumero("+524428575347")).toBe("+52 442 857 5347");
    expect(formatearNumero(null)).toBeNull();
  });
});
