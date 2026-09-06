import { describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import { ConectorMonday, renderPlantilla, type ConfigMonday } from "./conector.ts";
import type { ItemMonday } from "./cliente.ts";
import { crearApp } from "../app.ts";
import { hashApiKey } from "../auth.ts";
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

function conectorConFake() {
  const repo = new RepositorioEnMemoria({
    tenants: [
      { id: "demo", nombre: "Demo", plan: "basico", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-06T00:00:00Z" },
    ],
  });
  const encolados: any[] = [];
  const cola = { encolar: async (m: any) => encolados.push(m) } as any;
  const updates: { itemId: string; cuerpo: string }[] = [];
  const cliente = {
    getItem: async (id: string) => (id === "42" ? ITEM : null),
    crearUpdate: async (itemId: string, cuerpo: string) => {
      updates.push({ itemId, cuerpo });
      return "u1";
    },
  };
  const monday = new ConectorMonday({
    repo,
    cola,
    clienteFactory: () => cliente as any,
  });
  return { repo, monday, encolados, updates };
}

const CONFIG: ConfigMonday = {
  instanceId: "i1",
  apiToken: "tok-monday",
  signingSecret: "secreto-firma",
  columnaTelefono: "telefono",
  plantilla: "Hola {{nombre}}, debes {{saldo}}.",
};

describe("ConectorMonday.procesarEvento", () => {
  it("arma el mensaje desde el item, lo encola y guarda el vínculo", async () => {
    const { repo, monday, encolados } = conectorConFake();
    await repo.saveConectorMonday("demo", CONFIG);

    const r = await monday.procesarEvento("demo", { pulseId: 42, boardId: 9 });

    expect(encolados).toHaveLength(1);
    expect(encolados[0]).toMatchObject({
      instanceId: "i1",
      telefono: "+525512345678",
      cuerpo: "Hola Cliente Ejemplo, debes $1,200.",
      direccion: "out",
      estado: "encolado",
    });
    expect(r.itemId).toBe("42");
    // El vínculo vive ahora en la conversación (identidad estable).
    const conv = await repo.getConversacion("demo", "i1", "525512345678");
    expect(conv?.mondayItemId).toBe("42");
  });

  it("falla si el item no tiene teléfono en la columna configurada", async () => {
    const { repo, monday } = conectorConFake();
    await repo.saveConectorMonday("demo", { ...CONFIG, columnaTelefono: "noexiste" });
    await expect(
      monday.procesarEvento("demo", { pulseId: 42 }),
    ).rejects.toThrow(/teléfono/);
  });
});

describe("ConectorMonday.publicarEnItem", () => {
  it("publica el texto como update en el item", async () => {
    const { repo, monday, updates } = conectorConFake();
    await repo.saveConectorMonday("demo", CONFIG);
    await monday.publicarEnItem("demo", "42", "📥 sí, pago mañana");
    expect(updates).toEqual([{ itemId: "42", cuerpo: "📥 sí, pago mañana" }]);
  });

  it("no hace nada si el tenant no tiene conector configurado", async () => {
    const { monday, updates } = conectorConFake();
    await monday.publicarEnItem("demo", "42", "hola");
    expect(updates).toHaveLength(0);
  });
});

describe("ConectorMonday.verificarFirma", () => {
  const { monday } = conectorConFake();
  it("acepta un JWT válido firmado con el signing secret", () => {
    const token = jwt.sign({ foo: "bar" }, "secreto-firma", { algorithm: "HS256" });
    expect(monday.verificarFirma(CONFIG, `Bearer ${token}`)).toBe(true);
    expect(monday.verificarFirma(CONFIG, token)).toBe(true);
  });
  it("rechaza un JWT firmado con otro secreto o ausente", () => {
    const malo = jwt.sign({ foo: "bar" }, "otro-secreto", { algorithm: "HS256" });
    expect(monday.verificarFirma(CONFIG, `Bearer ${malo}`)).toBe(false);
    expect(monday.verificarFirma(CONFIG, undefined)).toBe(false);
  });
  it("no exige JWT si el tenant no configuró signingSecret", () => {
    expect(monday.verificarFirma({ ...CONFIG, signingSecret: "" }, undefined)).toBe(true);
  });
});

describe("POST /webhooks/monday/:tenantId (ruta)", () => {
  function levantar() {
    const { repo, monday } = conectorConFake();
    void repo.saveConectorMonday("demo", CONFIG);
    const server = crearApp(repo, undefined, { monday }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, cerrar: () => server.close() };
  }

  it("responde el challenge de verificación tal cual", async () => {
    const { base, cerrar } = levantar();
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
    const { base, cerrar } = levantar();
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
    const { base, cerrar } = levantar();
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
