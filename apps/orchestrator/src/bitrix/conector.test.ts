import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { ConectorBitrix, extraerId, type AltaConectorBitrix } from "./conector.ts";
import { normalizarWebhookBitrix, valorCampo, type EntidadBitrix, type RegistroBitrix } from "./cliente.ts";
import { Cripto } from "../cripto.ts";
import { crearApp } from "../app.ts";
import { RepositorioEnMemoria } from "../store.ts";

const cripto = new Cripto(Buffer.alloc(32, 9));

const DEAL: RegistroBitrix = {
  id: "759",
  nombre: "Cobro Septiembre",
  campos: {
    ID: "759",
    TITLE: "Cobro Septiembre",
    PHONE: [{ VALUE: "+52 55 1234 5678", VALUE_TYPE: "WORK" }],
    OPPORTUNITY: "1200",
  },
};

const ALTA: AltaConectorBitrix = {
  instanceId: "i1",
  entidad: "deal",
  campoTelefono: "PHONE",
  webhookUrl: "https://portal.bitrix24.mx/rest/1/secreto-abc/",
  applicationToken: "app-token-xyz",
  plantilla: "Hola {{nombre}}, debes {{OPPORTUNITY}}.",
};

function conectorConFake(getRegistro: (e: EntidadBitrix, id: string) => Promise<RegistroBitrix | null> = async () => DEAL) {
  const repo = new RepositorioEnMemoria({
    tenants: [{ id: "demo", nombre: "D", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-08T00:00:00Z" }],
  });
  const encolados: any[] = [];
  const cola = { encolar: async (m: any) => encolados.push(m) } as any;
  const timeline: { entidad: string; id: string; comentario: string }[] = [];
  const cliente = {
    validar: async () => {},
    listarCampos: async () => [{ id: "PHONE", title: "Teléfono", type: "crm_multifield" }],
    getRegistro,
    comentarTimeline: async (entidad: string, id: string, comentario: string) => {
      timeline.push({ entidad, id, comentario });
    },
  };
  const bitrix = new ConectorBitrix({ repo, cola, cripto, clienteFactory: () => cliente as any });
  return { repo, bitrix, encolados, timeline };
}

describe("normalizarWebhookBitrix", () => {
  const esperado = "https://portal.bitrix24.mx/rest/1/abc123/";
  it("acepta las tres formas y produce la misma base", () => {
    // Con barra final (webhook REST).
    expect(normalizarWebhookBitrix("https://portal.bitrix24.mx/rest/1/abc123/")).toBe(esperado);
    // Sin barra final.
    expect(normalizarWebhookBitrix("https://portal.bitrix24.mx/rest/1/abc123")).toBe(esperado);
    // Con /profile.json (generador de solicitudes) — la que revienta hoy.
    expect(normalizarWebhookBitrix("https://portal.bitrix24.mx/rest/1/abc123/profile.json")).toBe(esperado);
  });
  it("tolera espacios, doble barra y query", () => {
    expect(normalizarWebhookBitrix("  https://portal.bitrix24.mx/rest/1/abc123//  ")).toBe(esperado);
    expect(normalizarWebhookBitrix("https://portal.bitrix24.mx/rest/1/abc123/crm.deal.get.json?ID=1")).toBe(esperado);
  });
});

describe("helpers de Bitrix", () => {
  it("valorCampo resuelve el multifield PHONE y los escalares", () => {
    expect(valorCampo({ PHONE: [{ VALUE: "555", VALUE_TYPE: "WORK" }] }, "PHONE")).toBe("555");
    expect(valorCampo({ OPPORTUNITY: 1200 }, "OPPORTUNITY")).toBe("1200");
    expect(valorCampo({}, "NADA")).toBe("");
  });

  it("extraerId saca el id del payload del webhook saliente", () => {
    expect(extraerId({ event: "ONCRMDEALUPDATE", data: { FIELDS: { ID: "759" } } })).toBe("759");
    expect(extraerId({ data: { FIELDS: { id: 42 } } })).toBe("42");
    expect(extraerId({ id: "7" })).toBe("7");
    expect(extraerId({ data: {} })).toBeNull();
  });
});

describe("ConectorBitrix", () => {
  it("guardarAlta cifra el webhook y verConfig no lo expone", async () => {
    const { repo, bitrix } = conectorConFake();
    await bitrix.guardarAlta("demo", ALTA);
    const doc = (await repo.getConectorBitrix("demo"))!;
    expect(doc.webhookUrlCifrado).not.toContain("secreto-abc");
    expect(cripto.descifrar(doc.webhookUrlCifrado)).toBe(ALTA.webhookUrl);
    const vista = await bitrix.verConfig("demo");
    expect(vista).toMatchObject({ entidad: "deal", campoTelefono: "PHONE", tieneApplicationToken: true });
    expect(JSON.stringify(vista)).not.toContain("secreto-abc");
  });

  it("procesarEvento lee la entidad, arma el mensaje, lo encola y liga la conversación", async () => {
    const { repo, bitrix, encolados } = conectorConFake();
    await bitrix.guardarAlta("demo", ALTA);
    const r = await bitrix.procesarEvento("demo", { data: { FIELDS: { ID: "759" } } });
    expect(encolados[0]).toMatchObject({
      instanceId: "i1",
      telefono: "+525512345678",
      cuerpo: "Hola Cobro Septiembre, debes 1200.",
      estado: "encolado",
    });
    expect(r.plantillaId).toBe("default");
    const conv = await repo.getConversacion("demo", "i1", "525512345678");
    expect(conv?.bitrixEntidad).toEqual({ tipo: "deal", id: "759" });
    // Estado por plantilla registrado.
    const doc = (await repo.getConectorBitrix("demo"))!;
    expect(doc.plantillas[0]!.ultimoResultado).toMatchObject({ ok: true, itemId: "759" });
  });

  it("falla legible si la entidad no tiene teléfono en el campo mapeado", async () => {
    const { bitrix } = conectorConFake(async () => ({ id: "1", nombre: "X", campos: { PHONE: [] } }));
    await bitrix.guardarAlta("demo", ALTA);
    await expect(bitrix.procesarEvento("demo", { data: { FIELDS: { ID: "1" } } })).rejects.toThrow(/teléfono/);
    const reg = await bitrix.verRegistro("demo");
    expect(reg.ultimoResultado?.ok).toBe(false);
  });

  it("verificarFirma exige el application_token si se configuró", async () => {
    const { repo, bitrix } = conectorConFake();
    await bitrix.guardarAlta("demo", ALTA);
    const doc = (await repo.getConectorBitrix("demo"))!;
    expect(bitrix.verificarFirma(doc, { auth: { application_token: "app-token-xyz" } })).toBe(true);
    expect(bitrix.verificarFirma(doc, { auth: { application_token: "otro" } })).toBe(false);
    expect(bitrix.verificarFirma(doc, {})).toBe(false);
  });

  it("publicarEnItem escribe en el timeline de la entidad", async () => {
    const { bitrix, timeline } = conectorConFake();
    await bitrix.guardarAlta("demo", ALTA);
    await bitrix.publicarEnItem("demo", "deal", "759", "📥 ya pagué");
    expect(timeline).toEqual([{ entidad: "deal", id: "759", comentario: "📥 ya pagué" }]);
  });

  it("la ruta /webhooks/bitrix/:tenant/:plantillaId dispara la plantilla y verifica el token", async () => {
    const { repo, bitrix, encolados } = conectorConFake();
    await bitrix.guardarAlta("demo", ALTA);
    await bitrix.guardarPlantillas("demo", [
      { id: "default", nombre: "Principal", cuerpo: "P {{nombre}}" },
      { id: "recor", nombre: "Recordatorio", cuerpo: "Recuerda {{nombre}}" },
    ]);
    const server = crearApp(repo, undefined, { bitrix }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // Sin token válido → 401.
      const malo = await fetch(`${base}/webhooks/bitrix/demo/recor`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data[FIELDS][ID]=759",
      });
      expect(malo.status).toBe(401);
      // Con el application_token correcto (form-urlencoded, como Bitrix).
      const ok = await fetch(`${base}/webhooks/bitrix/demo/recor`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data[FIELDS][ID]=759&auth[application_token]=app-token-xyz",
      });
      expect(ok.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(encolados.at(-1).cuerpo).toBe("Recuerda Cobro Septiembre");
    } finally {
      server.close();
    }
  });
});
