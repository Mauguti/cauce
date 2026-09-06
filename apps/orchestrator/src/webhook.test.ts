import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "./app.ts";
import { RepositorioEnMemoria } from "./store.ts";
import { normalizarEntrante } from "./webhook.ts";
import type { GestorSesiones } from "./sesiones.ts";

const PAYLOAD_UPSERT = {
  event: "messages.upsert",
  instance: "cauce-a-i1",
  data: {
    key: {
      remoteJid: "5215587654321@s.whatsapp.net",
      fromMe: false,
      id: "BAE594145F4C59B4",
    },
    pushName: "Cliente",
    message: { conversation: "sí, mañana pago" },
    messageTimestamp: 1757100000,
  },
};

describe("normalizarEntrante", () => {
  it("convierte un messages.upsert en Message de core", () => {
    const m = normalizarEntrante("a", "i1", PAYLOAD_UPSERT);
    expect(m).toMatchObject({
      tenantId: "a",
      instanceId: "i1",
      direccion: "in",
      telefono: "+5215587654321",
      cuerpo: "sí, mañana pago",
      externalId: "BAE594145F4C59B4",
      timestamp: new Date(1757100000 * 1000).toISOString(),
    });
  });

  it("ignora mensajes propios, otros eventos, grupos y payloads rotos", () => {
    const propio = structuredClone(PAYLOAD_UPSERT);
    propio.data.key.fromMe = true;
    expect(normalizarEntrante("a", "i1", propio)).toBeNull();

    expect(
      normalizarEntrante("a", "i1", { event: "qrcode.updated", data: {} }),
    ).toBeNull();

    const grupo = structuredClone(PAYLOAD_UPSERT);
    grupo.data.key.remoteJid = "1234-5678@g.us";
    expect(normalizarEntrante("a", "i1", grupo)).toBeNull();

    expect(normalizarEntrante("a", "i1", {})).toBeNull();
    expect(normalizarEntrante("a", "i1", null)).toBeNull();
  });

  it("extrae texto de extendedTextMessage también", () => {
    const extendido = structuredClone(PAYLOAD_UPSERT) as any;
    delete extendido.data.message.conversation;
    extendido.data.message.extendedTextMessage = { text: "con formato" };
    expect(normalizarEntrante("a", "i1", extendido)?.cuerpo).toBe("con formato");
  });
});

describe("POST /webhooks/:tenantId/:instanceId", () => {
  function levantar() {
    const repo = new RepositorioEnMemoria({
      tenants: [
        { id: "a", nombre: "A", plan: "base", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z" },
      ],
      instances: [
        { id: "i1", tenantId: "a", transportType: "evolution", contenedorId: "c1", numero: null, estado: "connected", ultimoHeartbeat: null },
      ],
    });
    // Doble mínimo del gestor: solo lo que la ruta del webhook consulta.
    const gestor = {
      obtener: (id: string) =>
        id === "i1"
          ? { transport: null as never, contenedorId: "c1", baseUrl: "", webhookToken: "secreto-i1" }
          : null,
    } as unknown as GestorSesiones;
    const server = crearApp(repo, gestor).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { repo, base, cerrar: () => server.close() };
  }

  it("guarda el mensaje con token válido", async () => {
    const { repo, base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/webhooks/a/i1?token=secreto-i1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PAYLOAD_UPSERT),
      });
      expect(res.status).toBe(200);
      const mensajes = await repo.listMessages("a", "i1");
      expect(mensajes).toHaveLength(1);
      expect(mensajes[0]).toMatchObject({ direccion: "in", cuerpo: "sí, mañana pago" });
    } finally {
      cerrar();
    }
  });

  it("rechaza sin token o con token equivocado, sin escribir nada", async () => {
    const { repo, base, cerrar } = levantar();
    try {
      const sinToken = await fetch(`${base}/webhooks/a/i1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PAYLOAD_UPSERT),
      });
      expect(sinToken.status).toBe(401);

      const tokenMalo = await fetch(`${base}/webhooks/a/i1?token=adivinado`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PAYLOAD_UPSERT),
      });
      expect(tokenMalo.status).toBe(401);

      expect(await repo.listMessages("a", "i1")).toHaveLength(0);
    } finally {
      cerrar();
    }
  });

  it("acepta el token por header x-cauce-token", async () => {
    const { repo, base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/webhooks/a/i1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cauce-token": "secreto-i1",
        },
        body: JSON.stringify(PAYLOAD_UPSERT),
      });
      expect(res.status).toBe(200);
      expect(await repo.listMessages("a", "i1")).toHaveLength(1);
    } finally {
      cerrar();
    }
  });

  it("responde 404 para instancia sin sesión registrada", async () => {
    const { base, cerrar } = levantar();
    try {
      const res = await fetch(`${base}/webhooks/a/otra?token=lo-que-sea`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PAYLOAD_UPSERT),
      });
      expect(res.status).toBe(404);
    } finally {
      cerrar();
    }
  });
});
