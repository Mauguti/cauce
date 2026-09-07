import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import {
  ConectorMonday,
  renderPlantilla,
  type AltaConectorMonday,
} from "./conector.ts";
import type { ItemMonday } from "./cliente.ts";
import { Cripto } from "../cripto.ts";
import { crearApp } from "../app.ts";
import { RepositorioEnMemoria } from "../store.ts";

const ITEM: ItemMonday = {
  id: "42",
  name: "Cliente Ejemplo",
  columnas: {
    telefono: { id: "telefono", text: "+52 55 1234 5678", value: null },
    saldo: { id: "saldo", text: "$1,200", value: null },
    fecha: { id: "fecha", text: "2026-09-10", value: null },
  },
};

describe("renderPlantilla", () => {
  it("reemplaza {{nombre}} y {{columnId}}", () => {
    const out = renderPlantilla(
      "Hola {{nombre}}, tu saldo de {{saldo}} vence el {{fecha}}.",
      ITEM,
    );
    expect(out).toBe(
      "Hola Cliente Ejemplo, tu saldo de $1,200 vence el 2026-09-10.",
    );
  });

  it("deja vacías las variables que no existen", () => {
    expect(renderPlantilla("x {{noexiste}} y", ITEM)).toBe("x  y");
  });
});

// Cripto con llave fija de prueba (no depende del entorno).
const cripto = new Cripto(Buffer.alloc(32, 7));

function conectorConFake() {
  const repo = new RepositorioEnMemoria({
    tenants: [
      { id: "demo", nombre: "Demo", plan: "base", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-06T00:00:00Z" },
    ],
  });
  const encolados: any[] = [];
  const cola = { encolar: async (m: any) => encolados.push(m) } as any;
  const updates: { itemId: string; cuerpo: string }[] = [];
  const tokensUsados: string[] = [];
  const cliente = {
    getItem: async (id: string) => (id === "42" ? ITEM : null),
    crearUpdate: async (itemId: string, cuerpo: string) => {
      updates.push({ itemId, cuerpo });
      return "u1";
    },
    listarBoards: async () => [{ id: "b1", name: "Cobranza" }],
    listarColumnas: async () => [{ id: "telefono", title: "Teléfono", type: "phone" }],
  };
  const monday = new ConectorMonday({
    repo,
    cola,
    cripto,
    clienteFactory: (token: string) => {
      tokensUsados.push(token);
      return cliente as any;
    },
  });
  return { repo, monday, encolados, updates, tokensUsados };
}

const ALTA: AltaConectorMonday = {
  instanceId: "i1",
  boardId: "b1",
  apiToken: "tok-monday-secreto-1234",
  signingSecret: "secreto-firma",
  columnaTelefono: "telefono",
  plantilla: "Hola {{nombre}}, debes {{saldo}}.",
};

describe("ConectorMonday credenciales", () => {
  it("guardarAlta cifra el token en reposo (no queda en claro)", async () => {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    const doc = await repo.getConectorMonday("demo");
    expect(doc!.apiTokenCifrado).not.toContain("tok-monday-secreto-1234");
    expect(doc!.apiTokenCifrado.startsWith("gcm1:")).toBe(true);
    // Y se puede recuperar descifrando con la misma llave.
    expect(cripto.descifrar(doc!.apiTokenCifrado)).toBe("tok-monday-secreto-1234");
  });

  it("verConfig no expone secretos, solo la pista del token", async () => {
    const { monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    const vista = await monday.verConfig("demo");
    expect(vista).toMatchObject({
      instanceId: "i1",
      boardId: "b1",
      columnaTelefono: "telefono",
      apiTokenPista: "····1234",
      tieneSigningSecret: true,
    });
    expect(JSON.stringify(vista)).not.toContain("tok-monday-secreto-1234");
    expect(JSON.stringify(vista)).not.toContain("secreto-firma");
  });

  it("editar sin token conserva las credenciales guardadas", async () => {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    const antes = (await repo.getConectorMonday("demo"))!;

    // Reedición: cambia la columna, apiToken/signingSecret vacíos.
    await monday.guardarAlta("demo", {
      ...ALTA,
      apiToken: "",
      signingSecret: "",
      columnaTelefono: "otra",
    });
    const despues = (await repo.getConectorMonday("demo"))!;
    expect(despues.columnaTelefono).toBe("otra");
    expect(despues.apiTokenCifrado).toBe(antes.apiTokenCifrado);
    expect(despues.signingSecretCifrado).toBe(antes.signingSecretCifrado);
    expect(despues.apiTokenPista).toBe("····1234");
  });

  it("alta nueva sin token es rechazada", async () => {
    const { monday } = conectorConFake();
    await expect(
      monday.guardarAlta("demo", { ...ALTA, apiToken: "" }),
    ).rejects.toThrow(/API token/);
  });

  it("desconectar borra la config del conector", async () => {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    await monday.desconectar("demo");
    expect(await repo.getConectorMonday("demo")).toBeNull();
  });
});

describe("ConectorMonday.procesarEvento", () => {
  it("arma el mensaje desde el item, lo encola y guarda el vínculo", async () => {
    const { repo, monday, encolados, tokensUsados } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);

    const r = await monday.procesarEvento("demo", { pulseId: 42, boardId: 9 });

    expect(encolados[0]).toMatchObject({
      instanceId: "i1",
      telefono: "+525512345678",
      cuerpo: "Hola Cliente Ejemplo, debes $1,200.",
      direccion: "out",
      estado: "encolado",
    });
    expect(r.itemId).toBe("42");
    const conv = await repo.getConversacion("demo", "i1", "525512345678");
    expect(conv?.mondayItemId).toBe("42");
    // El cliente se instanció con el token DESCIFRADO, no el ciphertext.
    expect(tokensUsados).toContain("tok-monday-secreto-1234");
  });

  it("falla si el item no tiene teléfono en la columna configurada", async () => {
    const { monday } = conectorConFake();
    await monday.guardarAlta("demo", { ...ALTA, columnaTelefono: "noexiste" });
    await expect(
      monday.procesarEvento("demo", { pulseId: 42 }),
    ).rejects.toThrow(/teléfono/);
  });

  it("registra el resultado (ok) del disparo para la UI", async () => {
    const { monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    await monday.procesarEvento("demo", { pulseId: 42 });
    const reg = await monday.verRegistro("demo");
    expect(reg.ultimoResultado).toMatchObject({ ok: true, itemId: "42", telefono: "525512345678" });
  });

  it("registra el resultado (error legible) cuando el disparo falla", async () => {
    const { monday } = conectorConFake();
    await monday.guardarAlta("demo", { ...ALTA, columnaTelefono: "noexiste" });
    await monday.procesarEvento("demo", { pulseId: 42 }).catch(() => {});
    const reg = await monday.verRegistro("demo");
    expect(reg.ultimoResultado?.ok).toBe(false);
    expect((reg.ultimoResultado as any).error).toMatch(/teléfono/);
  });

  it("registrarLlamada marca la última llamada sin pisar el resultado", async () => {
    const { monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    await monday.procesarEvento("demo", { pulseId: 42 });
    await monday.registrarLlamada("demo");
    const reg = await monday.verRegistro("demo");
    expect(reg.ultimaLlamadaEn).not.toBeNull();
    expect(reg.ultimoResultado?.ok).toBe(true);
  });
});

describe("ConectorMonday.publicarEnItem", () => {
  it("publica el texto como update en el item", async () => {
    const { monday, updates } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    await monday.publicarEnItem("demo", "42", "📥 sí, pago mañana");
    expect(updates).toEqual([{ itemId: "42", cuerpo: "📥 sí, pago mañana" }]);
  });

  it("no hace nada si el tenant no tiene conector configurado", async () => {
    const { monday, updates } = conectorConFake();
    await monday.publicarEnItem("demo", "42", "hola");
    expect(updates).toHaveLength(0);
  });
});

describe("ConectorMonday plantillas múltiples", () => {
  it("migra un doc viejo (plantilla) a la plantilla por defecto, y sigue disparando por la URL corta", async () => {
    const { repo, monday, encolados } = conectorConFake();
    // Doc con el modelo VIEJO: un solo campo `plantilla`.
    await repo.saveConectorMonday("demo", {
      instanceId: "i1", boardId: "b1", boardNombre: "B",
      columnaTelefono: "telefono",
      apiTokenCifrado: cripto.cifrar("tok"), signingSecretCifrado: "",
      apiTokenPista: "····tok",
      plantilla: "Hola {{nombre}}",
    } as any);

    const vista = await monday.verConfig("demo");
    expect(vista!.plantillas).toEqual([
      { id: "default", nombre: "Plantilla principal", cuerpo: "Hola {{nombre}}" },
    ]);

    // Sin plantillaId (URL corta) usa la por defecto: la migración no rompe.
    await monday.procesarEvento("demo", { pulseId: 42 });
    expect(encolados[0].cuerpo).toBe("Hola Cliente Ejemplo");
  });

  it("guardarPlantillas + disparo por id usa esa plantilla y registra su estado", async () => {
    const { repo, monday, encolados } = conectorConFake();
    await monday.guardarAlta("demo", ALTA); // siembra "default"
    await monday.guardarPlantillas("demo", [
      { id: "default", nombre: "Principal", cuerpo: "P {{nombre}}" },
      { id: "bienve", nombre: "Bienvenida", cuerpo: "Bienvenido {{nombre}}" },
    ]);

    await monday.procesarEvento("demo", { pulseId: 42 }, "bienve");
    expect(encolados.at(-1).cuerpo).toBe("Bienvenido Cliente Ejemplo");

    // El estado por plantilla queda en el doc, para el listado.
    const doc = (await repo.getConectorMonday("demo"))!;
    const bienve = doc.plantillas.find((p) => p.id === "bienve")!;
    expect(bienve.ultimoResultado).toMatchObject({ ok: true, itemId: "42" });
    expect(bienve.ultimoDisparoEn).toBeTruthy();
    // La otra plantilla no se disparó: sin estado.
    expect(doc.plantillas.find((p) => p.id === "default")!.ultimoDisparoEn ?? null).toBeNull();
  });

  it("guardarPlantillas conserva el estado de disparo de las que sobreviven", async () => {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    await monday.procesarEvento("demo", { pulseId: 42 }); // dispara la default
    // Reedita la lista (renombra la default): su estado debe conservarse.
    await monday.guardarPlantillas("demo", [
      { id: "default", nombre: "Renombrada", cuerpo: "otra cosa {{nombre}}" },
    ]);
    const doc = (await repo.getConectorMonday("demo"))!;
    expect(doc.plantillas[0]!.nombre).toBe("Renombrada");
    expect(doc.plantillas[0]!.ultimoResultado).toMatchObject({ ok: true });
  });

  it("dispara por la URL /webhooks/monday/:tenant/:plantillaId", async () => {
    const { repo, monday, encolados } = conectorConFake();
    await monday.guardarAlta("demo", { ...ALTA, signingSecret: "" }); // sin firma
    await monday.guardarPlantillas("demo", [
      { id: "default", nombre: "Principal", cuerpo: "P {{nombre}}" },
      { id: "recor", nombre: "Recordatorio", cuerpo: "Recuerda {{nombre}}" },
    ]);
    const server = crearApp(repo, undefined, { monday }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/webhooks/monday/demo/recor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { pulseId: 42 } }),
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50)); // el disparo es async tras el 200
      expect(encolados.at(-1).cuerpo).toBe("Recuerda Cliente Ejemplo");
    } finally {
      server.close();
    }
  });
});

describe("ConectorMonday.verificarFirma", () => {
  it("acepta JWT válido, rechaza inválido/ausente, no exige si no hay secret", async () => {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    const doc = (await repo.getConectorMonday("demo"))!;

    const bueno = jwt.sign({ foo: 1 }, "secreto-firma", { algorithm: "HS256" });
    expect(monday.verificarFirma(doc, `Bearer ${bueno}`)).toBe(true);
    expect(monday.verificarFirma(doc, bueno)).toBe(true);

    const malo = jwt.sign({ foo: 1 }, "otro", { algorithm: "HS256" });
    expect(monday.verificarFirma(doc, `Bearer ${malo}`)).toBe(false);
    expect(monday.verificarFirma(doc, undefined)).toBe(false);

    // Alta fresca sin secret (en otro tenant): no se exige JWT.
    await monday.guardarAlta("otro", { ...ALTA, signingSecret: "" });
    const sinSecret = (await repo.getConectorMonday("otro"))!;
    expect(monday.verificarFirma(sinSecret, undefined)).toBe(true);
  });
});

describe("POST /webhooks/monday/:tenantId (ruta)", () => {
  async function levantar() {
    const { repo, monday } = conectorConFake();
    await monday.guardarAlta("demo", ALTA);
    const server = crearApp(repo, undefined, { monday }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, cerrar: () => server.close() };
  }

  it("responde el challenge de verificación tal cual", async () => {
    const { base, cerrar } = await levantar();
    try {
      const res = await fetch(`${base}/webhooks/monday/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: "abc123" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ challenge: "abc123" });
    } finally {
      cerrar();
    }
  });

  it("rechaza un evento con firma inválida (401)", async () => {
    const { base, cerrar } = await levantar();
    try {
      const res = await fetch(`${base}/webhooks/monday/demo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer malo" },
        body: JSON.stringify({ event: { pulseId: 42 } }),
      });
      expect(res.status).toBe(401);
    } finally {
      cerrar();
    }
  });

  it("acepta un evento con JWT válido (200)", async () => {
    const { base, cerrar } = await levantar();
    try {
      const token = jwt.sign({ foo: 1 }, "secreto-firma", { algorithm: "HS256" });
      const res = await fetch(`${base}/webhooks/monday/demo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ event: { pulseId: 42 } }),
      });
      expect(res.status).toBe(200);
    } finally {
      cerrar();
    }
  });
});
