import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "../app.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { MotorEntrada } from "./motor.ts";
import { ConectorMonday } from "../monday/conector.ts";
import type { GestorSesiones } from "../sesiones.ts";

/**
 * Camino completo del entrante: webhook de Evolution → motor de entrada.
 * Verifica que un mensaje entrante crea la conversación, dispara la
 * respuesta automática por el carril inmediato y hace write-back a monday.
 */
function payloadEntrante(cuerpo: string, telefono = "5215512345678") {
  return {
    event: "messages.upsert",
    data: {
      key: { remoteJid: `${telefono}@s.whatsapp.net`, fromMe: false, id: "BAE1" },
      message: { conversation: cuerpo },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

describe("webhook entrante → motor de entrada", () => {
  it("primer contacto: guarda conversación, responde inmediato y actualiza monday", async () => {
    const repo = new RepositorioEnMemoria({
      tenants: [
        { id: "demo", nombre: "Demo", plan: "base", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-06T00:00:00Z" },
      ],
      instances: [
        { id: "i1", tenantId: "demo", transportType: "evolution", contenedorId: "c1", numero: null, estado: "connected", ultimoHeartbeat: null },
      ],
    });
    await repo.saveDisparadores("demo", [
      { id: "bienvenida", prioridad: 1, tipo: "primer_contacto", activo: true, respuesta: "¡Hola! Te leemos." },
    ]);
    // La conversación ya viene vinculada a un item de monday (contacto
    // proactivo previo desde el CRM).
    await repo.saveConectorMonday("demo", {
      instanceId: "i1", boardId: "b1", boardNombre: "B", apiTokenCifrado: "", signingSecretCifrado: "",
      apiTokenPista: "····", columnaTelefono: "tel", plantilla: "x",
    });
    await repo.vincularMonday("demo", "i1", "5215512345678", "item-5");

    const enviados: { telefono: string; cuerpo: string }[] = [];
    const updatesMonday: { itemId: string; cuerpo: string }[] = [];

    // Gestor falso: sesión activa (para el token del webhook) + enviarDirecto.
    const gestor = {
      obtener: (id: string) =>
        id === "i1" ? { transport: {}, contenedorId: "c1", baseUrl: "", webhookToken: "tok-web" } : null,
      enviarDirecto: async (_t: string, _i: string, telefono: string, cuerpo: string) => {
        enviados.push({ telefono, cuerpo });
        return {} as any;
      },
    } as unknown as GestorSesiones;

    const monday = new ConectorMonday({
      repo,
      cola: { encolar: async () => {} } as any,
      clienteFactory: () => ({
        getItem: async () => null,
        crearUpdate: async (itemId: string, cuerpo: string) => {
          updatesMonday.push({ itemId, cuerpo });
          return "u1";
        },
      }) as any,
    });

    const motorEntrada = new MotorEntrada({
      repo,
      monday,
      enviarInmediato: (t, i, tel, cuerpo) => gestor.enviarDirecto(t, i, tel, cuerpo),
    });

    const server = crearApp(repo, gestor, { monday, motorEntrada }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/webhooks/demo/i1?token=tok-web`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadEntrante("hola, ¿qué tal?")),
      });
      expect(res.status).toBe(200);

      // El motor corre async tras el 200; esperamos a que se asiente.
      await new Promise((r) => setTimeout(r, 100));

      // Conversación creada.
      const conv = await repo.getConversacion("demo", "i1", "5215512345678");
      expect(conv?.primerContactoEn).not.toBeNull();
      expect(conv?.mondayItemId).toBe("item-5");

      // Respuesta automática por el carril inmediato.
      expect(enviados).toEqual([
        { telefono: "+5215512345678", cuerpo: "¡Hola! Te leemos." },
      ]);

      // Write-back a monday con el texto del cliente.
      expect(updatesMonday).toEqual([{ itemId: "item-5", cuerpo: "📥 hola, ¿qué tal?" }]);

      // El entrante y el saliente quedaron en el historial.
      const msgs = await repo.listMessages("demo", "i1");
      expect(msgs.some((m) => m.direccion === "in")).toBe(true);
    } finally {
      server.close();
    }
  });
});
