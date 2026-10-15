import { afterEach, describe, expect, it } from "vitest";
import type { Message, Tenant } from "@cauce/core";
import { completarLada, formasEquivalentes, idConversacion, telefonoCanonico } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { MotorEntrada } from "./motor.ts";
import type { DisparadorEntrada } from "./disparadores.ts";
import { ConectorMonday } from "../monday/conector.ts";
import { Cripto } from "../cripto.ts";
import { chatExterno } from "../bitrix/openlines/tipos.ts";

/**
 * La llave de conversación es el teléfono canónico (forma del JID de
 * WhatsApp, por país). Decidido el 15-oct-2026: los salientes del CRM
 * salían como +52+10 y las respuestas llegaban como +521+10, partiendo a
 * cada contacto en dos conversaciones (tasa de respuesta 0 %, hilos
 * partidos, "primer contacto" en la respuesta).
 */

describe("telefonoCanonico por país", () => {
  it("México: 52+10 y 521+10 son el mismo canónico (521+10); sin lada se completa con el país", () => {
    expect(telefonoCanonico("+52 55 1234 5678")).toBe("5215512345678");
    expect(telefonoCanonico("+5215512345678")).toBe("5215512345678");
    expect(telefonoCanonico("5215512345678")).toBe("5215512345678");
    expect(telefonoCanonico("55 1234 5678", "MX")).toBe("5215512345678");
    expect(telefonoCanonico("00525512345678")).toBe("5215512345678");
    expect(completarLada("55 1234 5678", "MX")).toBe("525512345678");
    expect(completarLada("+52 55 1234 5678")).toBe("525512345678"); // no mete el 1: es "como vino"
  });

  it("otros países: nunca se les mete un 1; sin lada se completa con SU país", () => {
    expect(telefonoCanonico("+1 (555) 010-2030")).toBe("15550102030");
    expect(telefonoCanonico("555 010 2030", "US")).toBe("15550102030");
    expect(telefonoCanonico("+54 9 11 2345 6789")).toBe("5491123456789");
    expect(telefonoCanonico("+57 300 123 4567")).toBe("573001234567");
    // Un número que empieza con 52 pero no es mexicano de 10 dígitos no se toca.
    expect(telefonoCanonico("+5212345")).toBe("5212345");
    expect(telefonoCanonico("")).toBe("");
    expect(telefonoCanonico(null)).toBe("");
  });

  it("formasEquivalentes da todas las formas guardadas que equivalen al mismo canónico", () => {
    expect(formasEquivalentes("+52 55 1234 5678").sort()).toEqual(["5215512345678", "525512345678"]);
    expect(formasEquivalentes("+15550102030")).toEqual(["15550102030"]);
    expect(idConversacion("t", "i", "+525512345678")).toBe(idConversacion("t", "i", "+5215512345678"));
    expect(chatExterno("i1", "+525512345678")).toBe("i1:5215512345678");
  });
});

const BIENVENIDA: DisparadorEntrada = { id: "bienvenida", prioridad: 1, tipo: "primer_contacto", activo: true, respuesta: "¡Hola! Gracias por escribir." };
const TENANT: Tenant = { id: "demo", nombre: "Demo", pais: "MX", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-05T00:00:00Z" };

function armar() {
  const repo = new RepositorioEnMemoria({
    tenants: [TENANT],
    instances: [{ id: "i1", tenantId: "demo", transportType: "mock", contenedorId: null, numero: "+5214420000009", estado: "connected", ultimoHeartbeat: null }],
  });
  void repo.saveDisparadores("demo", [BIENVENIDA]);
  const encolados: Message[] = [];
  const updates: { itemId: string; cuerpo: string }[] = [];
  const cliente = {
    getItem: async (id: string) => (id === "42" ? { id: "42", name: "Cliente Ejemplo", boardId: "b1", columnas: { telefono: { id: "telefono", text: "+52 55 1234 5678", value: null } } } : null),
    crearUpdate: async (itemId: string, cuerpo: string) => { updates.push({ itemId, cuerpo }); return "u1"; },
  };
  const monday = new ConectorMonday({ repo, cola: { encolar: async (m: Message) => { encolados.push(m); await repo.saveMessage(m); } } as any, cripto: new Cripto(Buffer.alloc(32, 3)), clienteFactory: () => cliente as any });
  const enviados: string[] = [];
  const motor = new MotorEntrada({ repo, monday, enviarInmediato: async (_t, _i, _tel, cuerpo) => { enviados.push(cuerpo); } });
  return { repo, monday, motor, encolados, updates, enviados };
}
afterEach(() => usarSalida(null));

describe("saliente +52 del CRM y respuesta +521 de WhatsApp = UNA conversación", () => {
  it("la respuesta cae en la misma conversación, con el item vinculado, NO es primer contacto, el hilo incluye ambos mensajes y el write-back llega al item", async () => {
    const c = armar();
    await c.monday.guardarAlta("demo", { instanceId: "i1", boardId: "b1", apiToken: "tok", signingSecret: "", columnaTelefono: "telefono", plantilla: "Hola {{nombre}}, tu saldo." });
    await c.monday.procesarEvento("demo", { pulseId: 42, boardId: "b1" });
    // El saliente se guarda como vino del CRM.
    expect(c.encolados[0]!.telefono).toBe("+525512345678");
    expect((await c.repo.listConversaciones("demo")).map((x) => x.telefono)).toEqual(["5215512345678"]);

    // Responde desde WhatsApp con el JID mexicano (+521).
    const respuesta: Message = { id: "in1", tenantId: "demo", instanceId: "i1", direccion: "in", telefono: "+5215512345678", cuerpo: "sí, pago mañana", estado: "recibido", externalId: null, timestamp: "2026-10-15T15:00:00Z" };
    await c.repo.saveMessage(respuesta);
    await c.motor.procesar("demo", "i1", respuesta, "Cliente");

    const convs = await c.repo.listConversaciones("demo");
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ telefono: "5215512345678", mondayItemId: "42", primerContactoEn: "2026-10-15T15:00:00Z" });
    // No es primer contacto: ya se le había escrito. Nada de bienvenida.
    expect(c.enviados).toEqual([]);
    // El write-back al CRM llegó al item vinculado por el saliente.
    expect(c.updates.some((u) => u.itemId === "42" && u.cuerpo.includes("sí, pago mañana"))).toBe(true);
    // El hilo de la conversación trae el saliente (+52) y la respuesta (+521), se consulte con la forma que sea.
    const hilo = await c.repo.listMessagesDeConversacion("demo", "i1", "+525512345678", 10);
    expect(hilo.map((m) => m.direccion)).toEqual(["out", "in"]);
    expect(await c.repo.listMessagesDeConversacion("demo", "i1", "5215512345678", 10)).toHaveLength(2);
    // Y por cualquiera de las dos formas se llega al mismo documento.
    expect((await c.repo.getConversacion("demo", "i1", "525512345678"))?.mondayItemId).toBe("42");
    expect((await c.repo.getConversacion("demo", "i1", "+5215512345678"))?.mondayItemId).toBe("42");
  });

  it("un contacto nuevo que escribe primero sí recibe bienvenida (nada cambió para ese caso)", async () => {
    const c = armar();
    const m: Message = { id: "in2", tenantId: "demo", instanceId: "i1", direccion: "in", telefono: "+5215599990000", cuerpo: "hola", estado: "recibido", externalId: null, timestamp: "2026-10-15T15:00:00Z" };
    await c.repo.saveMessage(m);
    await c.motor.procesar("demo", "i1", m, "Nuevo");
    expect(c.enviados).toEqual(["¡Hola! Gracias por escribir."]);
  });

  it("directorio: una persona dada de alta como +52 se reconoce cuando escribe como +521", async () => {
    const c = armar();
    await c.repo.savePersonaDirectorio("demo", { telefono: telefonoCanonico("+52 442 000 0100", "MX"), nombre: "Raúl", rol: "dueno", calendarioId: null, modoClienteHasta: null, creadoEn: "2026-10-15T00:00:00Z", actualizadoEn: "2026-10-15T00:00:00Z" });
    expect((await c.repo.getPersonaDirectorio("demo", "+5214420000100"))?.nombre).toBe("Raúl");
    expect((await c.repo.getPersonaDirectorio("demo", "524420000100"))?.nombre).toBe("Raúl");
  });
});
