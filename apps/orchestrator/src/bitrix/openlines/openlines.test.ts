import { describe, expect, it } from "vitest";
import { chatExterno, partirChatExterno } from "./tipos.ts";
import { refrescarTokens, tokensDesdeAuth, tokenVigente } from "./oauth.ts";
import { ClienteOpenlines, interpretarEventoMensajes } from "./cliente.ts";

const AUTH = {
  access_token: "acc-1", refresh_token: "ref-1", expires_in: "3600",
  client_endpoint: "https://digsol.bitrix24.mx/rest/", domain: "digsol.bitrix24.mx",
  member_id: "m1", application_token: "apptok",
};

describe("chat externo (instancia:teléfono)", () => {
  it("es estable y reversible; el teléfono va en dígitos", () => {
    expect(chatExterno("f77d6518", "+52 1 442 857 5347")).toBe("f77d6518:5214428575347");
    expect(partirChatExterno("f77d6518:5214428575347")).toEqual({ instanceId: "f77d6518", telefono: "5214428575347" });
    expect(partirChatExterno("basura")).toBeNull();
    expect(partirChatExterno("i:abc")).toBeNull();
  });
});

describe("OAuth de la app local", () => {
  it("convierte el bloque auth de Bitrix y calcula la caducidad", () => {
    const t = tokensDesdeAuth(AUTH, 1_000_000);
    expect(t.accessToken).toBe("acc-1");
    expect(t.clientEndpoint).toBe("https://digsol.bitrix24.mx/rest/");
    expect(t.expiraEn).toBe(1_000_000 + 3_600_000);
    expect(tokenVigente(t, 1_000_000)).toBe(true);
    expect(tokenVigente(t, 1_000_000 + 3_600_000 - 30_000)).toBe(false); // dentro del margen
  });

  it("rechaza un auth incompleto diciendo qué falta", () => {
    expect(() => tokensDesdeAuth({ ...AUTH, application_token: "" })).toThrow(/falta application_token/);
  });

  it("renueva contra oauth.bitrix.info con client_id/secret y conserva el endpoint", async () => {
    const llamadas: string[] = [];
    const fetchImpl = (async (url: string) => {
      llamadas.push(url);
      return new Response(JSON.stringify({ access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = tokensDesdeAuth(AUTH, 0);
    const nuevo = await refrescarTokens(t, { clientId: "cid", clientSecret: "sec" }, { fetchImpl, ahora: 5_000 });
    expect(llamadas[0]).toContain("oauth.bitrix.info/oauth/token/");
    expect(llamadas[0]).toContain("grant_type=refresh_token");
    expect(llamadas[0]).toContain("client_id=cid");
    expect(nuevo).toMatchObject({ accessToken: "acc-2", refreshToken: "ref-2", clientEndpoint: "https://digsol.bitrix24.mx/rest/", applicationToken: "apptok" });
    expect(nuevo.expiraEn).toBe(5_000 + 3_600_000);
  });
});

describe("ClienteOpenlines", () => {
  function armar(respuestas: ((url: string, body: any) => Response)[]) {
    const peticiones: { url: string; body: any }[] = [];
    let i = 0;
    const fetchImpl = (async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      peticiones.push({ url, body });
      const r = respuestas[Math.min(i, respuestas.length - 1)]!;
      i += 1;
      return r(url, body);
    }) as unknown as typeof fetch;
    const renovados: string[] = [];
    const cliente = new ClienteOpenlines({
      tokens: tokensDesdeAuth(AUTH, Date.now()),
      credenciales: { clientId: "cid", clientSecret: "sec" },
      alRenovar: async (t) => { renovados.push(t.accessToken); },
      fetchImpl,
    });
    return { cliente, peticiones, renovados };
  }
  const ok = (result: unknown) => () => new Response(JSON.stringify({ result }), { status: 200 });

  it("manda el token en `auth` y devuelve session.CHAT_ID/ID de send.messages sin asumirlos", async () => {
    const { cliente, peticiones } = armar([
      ok({ SUCCESS: true, DATA: { RESULT: [{ user: "7", session: { ID: "55", CHAT_ID: "901" } }] } }),
    ]);
    const r = await cliente.enviarEntrante({
      connector: "digsol_factory", line: 3, chatId: "f77d6518:5214428575347",
      usuario: { id: "5214428575347", nombre: "Mau", telefono: "+5214428575347" },
      mensaje: { id: "m1", fecha: new Date(1_700_000_000_000), texto: "hola" },
    });
    expect(r).toEqual({ chatId: "901", sessionId: "55" });
    expect(peticiones[0]!.url).toBe("https://digsol.bitrix24.mx/rest/imconnector.send.messages");
    expect(peticiones[0]!.body.auth).toBe("acc-1");
    expect(peticiones[0]!.body.MESSAGES[0].chat.id).toBe("f77d6518:5214428575347");
    expect(peticiones[0]!.body.MESSAGES[0].message.date).toBe(1_700_000_000);
  });

  it("con expired_token renueva una vez, persiste los tokens y reintenta", async () => {
    const { cliente, peticiones, renovados } = armar([
      () => new Response(JSON.stringify({ error: "expired_token", error_description: "The access token provided has expired." }), { status: 401 }),
      (url) => url.includes("oauth.bitrix.info")
        ? new Response(JSON.stringify({ access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ result: true }), { status: 200 }),
      ok(true),
    ]);
    const r = await cliente.activarConector({ connector: "digsol_factory", line: 3, active: true });
    expect(r).toBe(true);
    expect(renovados).toEqual(["acc-2"]);
    const ultima = peticiones[peticiones.length - 1]!;
    expect(ultima.url).toContain("imconnector.activate");
    expect(ultima.body.auth).toBe("acc-2");
  });

  it("un error de Bitrix sube con el método y la descripción literal", async () => {
    const { cliente } = armar([() => new Response(JSON.stringify({ error: "ACCESS_DENIED", error_description: "no imconnector scope" }), { status: 403 })]);
    await expect(cliente.suscribirMensajes("https://x/h")).rejects.toThrow(/event\.bind.*no imconnector scope/);
  });
});

describe("interpretarEventoMensajes", () => {
  it("saca chat externo, ids internos, texto, user_id y adjuntos si vienen", () => {
    const r = interpretarEventoMensajes({
      CONNECTOR: "digsol_factory",
      LINE: "3",
      MESSAGES: [{
        im: { chat_id: "901", message_id: "1234" },
        message: { text: "Hola, ¿en qué te ayudo?", user_id: "12", files: [{ url: "https://p/f.jpg", name: "f.jpg" }] },
        chat: { id: "f77d6518:5214428575347" },
      }],
    });
    expect(r.connector).toBe("digsol_factory");
    expect(r.line).toBe(3);
    expect(r.mensajes).toMatchObject([{
      chatExternoId: "f77d6518:5214428575347", imChatId: 901, imMessageId: 1234,
      texto: "Hola, ¿en qué te ayudo?", userId: 12, archivos: [{ url: "https://p/f.jpg", nombre: "f.jpg" }],
    }]);
    expect(r.mensajes[0]!.crudo).toMatchObject({ chat: { id: "f77d6518:5214428575347" } });
  });

  it("tolera MESSAGES como objeto (form-urlencoded) y descarta entradas sin ids", () => {
    const r = interpretarEventoMensajes({ CONNECTOR: "c", LINE: 1, MESSAGES: { 0: { chat: { id: "a:5214428575347" } } } });
    expect(r.mensajes).toEqual([]);
  });
});
