import { afterEach, describe, expect, it } from "vitest";
import type { Message, PersonaDirectorio, Tenant } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { Agente } from "./agente.ts";
import { Citas, MODO_CLIENTE_HORAS } from "./citas.ts";
import type { ProveedorModelo, PeticionModelo } from "./proveedor.ts";
import type { ClienteCalendario, EventoCalendario } from "../google/calendario.ts";

/** Calendario en memoria; `alInsertar` simula a alguien que agenda por fuera justo después de nuestro insert. */
class CalendarioFalso implements ClienteCalendario {
  zona = "America/Mexico_City";
  eventos_ = new Map<string, EventoCalendario[]>();
  alInsertar: ((cal: string, e: EventoCalendario) => void) | null = null;
  n = 0;
  lista(cal: string) { return this.eventos_.get(cal) ?? []; }
  agregar(cal: string, e: Partial<EventoCalendario> & Pick<EventoCalendario, "inicio" | "fin">): EventoCalendario {
    const ev: EventoCalendario = { id: `ext_${++this.n}`, titulo: "Ocupado", descripcion: null, privado: {}, estado: "confirmed", todoElDia: false, ...e };
    this.eventos_.set(cal, [...this.lista(cal), ev]);
    return ev;
  }
  async eventos(_t: string, cal: string, desde: string, hasta: string) {
    return { zona: this.zona, eventos: this.lista(cal).filter((e) => e.inicio < hasta && desde < e.fin) };
  }
  async insertar(_t: string, cal: string, e: { inicio: string; fin: string; titulo: string; descripcion: string; privado: Record<string, string> }) {
    const ev: EventoCalendario = { id: `ev_${++this.n}`, inicio: e.inicio, fin: e.fin, titulo: e.titulo, descripcion: e.descripcion, privado: e.privado, estado: "confirmed", todoElDia: false };
    this.eventos_.set(cal, [...this.lista(cal), ev]);
    this.alInsertar?.(cal, ev);
    return ev;
  }
  async borrar(_t: string, cal: string, id: string) { this.eventos_.set(cal, this.lista(cal).filter((e) => e.id !== id)); }
  async mover(_t: string, cal: string, id: string, inicio: string, fin: string) {
    const e = this.lista(cal).find((x) => x.id === id)!;
    e.inicio = inicio; e.fin = fin;
    return e;
  }
}

const TENANT: Tenant = {
  id: "t1", nombre: "Taller Gómez", plan: "pro", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-01T00:00:00Z",
  agente: { activo: true, nombre: "Susana", rol: "citas", proveedor: "anthropic", modelo: "claude-opus-5" },
  agenda: { calendarioId: "primary", duracionMin: 60, horario: { dias: [1, 2, 3, 4, 5, 6], desde: "09:00", hasta: "14:00" }, anticipacionMin: 60, ventanaDias: 7 },
};
const DUENO: PersonaDirectorio = { telefono: "5214420000100", nombre: "Raúl", rol: "dueno", calendarioId: null, modoClienteHasta: null, creadoEn: "2026-09-01T00:00:00Z", actualizadoEn: "2026-09-01T00:00:00Z" };
const CLIENTE = "5215512345678";
const OTRO = "5215500000001";
// Viernes 18-sep-2026, 08:00 local (UTC−6) = 14:00Z
const T0 = Date.parse("2026-09-18T14:00:00Z");

function entrante(telefono: string, cuerpo: string, id = crypto.randomUUID()): Message {
  return { id, tenantId: "t1", instanceId: "A", direccion: "in", telefono: `+${telefono}`, cuerpo, estado: "recibido", externalId: null, timestamp: new Date(T0).toISOString() };
}

/** Proveedor guion: cada respuesta del modelo es una lista de llamadas a herramientas y un texto final. */
type Paso = { herramientas?: { nombre: string; args?: Record<string, unknown> }[]; texto: string };
function armar(opciones: { zona?: string } = {}) {
  const repo = new RepositorioEnMemoria({ tenants: [TENANT], instances: [{ id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000009", estado: "connected", ultimoHeartbeat: null }] });
  void repo.savePersonaDirectorio("t1", DUENO);
  void repo.saveConectorGoogle("t1", { email: "taller@gmail.com", refreshTokenCifrado: "enc:x", scope: "calendar.events", conectadoEn: "2026-09-01T00:00:00Z" });
  const calendario = new CalendarioFalso();
  if (opciones.zona) calendario.zona = opciones.zona;
  let reloj = T0;
  const guion: Paso[] = [];
  const resultados: string[] = [];
  const sistemas: string[] = [];
  const proveedor: ProveedorModelo = {
    nombre: "anthropic",
    async responder(p: PeticionModelo) {
      sistemas.push(p.sistema);
      const paso = guion.shift() ?? { texto: "ok" };
      const usadas: string[] = [];
      for (const h of paso.herramientas ?? []) {
        usadas.push(h.nombre);
        resultados.push(await p.ejecutar!(h.nombre, h.args ?? {}));
      }
      return { texto: paso.texto, modelo: "claude-opus-5", uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 }, costoUsd: 0.0001, parada: "end_turn", herramientasUsadas: usadas };
    },
  };
  const citas = new Citas({ repo, calendario, ahora: () => reloj });
  const agente = new Agente({ repo, proveedores: { anthropic: proveedor }, citas });
  const bitacora: string[] = [];
  usarSalida((_n, l) => { bitacora.push(l); });
  return { repo, calendario, agente, guion, resultados, sistemas, bitacora, avanzar: (ms: number) => { reloj += ms; } };
}
afterEach(() => usarSalida(null));

describe("Susana · disponibilidad y zona horaria", () => {
  it("ofrece horas del horario del negocio en la zona del calendario, sin las ocupadas ni las de menos de la anticipación", async () => {
    const c = armar();
    // 10:00–11:00 local ocupado (16:00Z)
    c.calendario.agregar("primary", { inicio: "2026-09-18T16:00:00Z", fin: "2026-09-18T17:00:00Z" });
    c.guion.push({ herramientas: [{ nombre: "consultar_disponibilidad", args: { fecha: "2026-09-18" } }], texto: "Tengo 9, 11 o 12." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "¿Tienen hoy?"), "Laura");
    expect(c.resultados[0]).toContain("viernes, 18 de septiembre (2026-09-18): 09:00, 11:00, 12:00, 13:00");
    expect(c.resultados[0]).toContain("America/Mexico_City");
    expect(c.sistemas[0]).toContain("Hoy es viernes, 18 de septiembre, 08:00 (zona America/Mexico_City)");
    expect(c.sistemas[0]).toContain("un cliente (no está en el directorio");
  });

  it("con el calendario en Tijuana, la misma hora local es otro instante y el prompt lo dice", async () => {
    const c = armar({ zona: "America/Tijuana" });
    c.guion.push({ herramientas: [{ nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "10:00", nombre: "Laura" } }], texto: "¿Confirmo?" });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "a las 10"), "Laura");
    const conv = await c.repo.getConversacion("t1", "A", CLIENTE);
    expect(conv?.citaPendiente?.inicio).toBe("2026-09-18T17:00:00.000Z"); // 10:00 PDT = 17:00Z
    expect(c.sistemas[0]).toContain("07:00 (zona America/Tijuana)");
    expect(c.resultados[0]).toContain("vie 18 de sep 10:00");
  });

  it("no ofrece domingo ni fechas pasadas ni más allá de la ventana", async () => {
    const c = armar();
    c.guion.push({ herramientas: [
      { nombre: "consultar_disponibilidad", args: { fecha: "2026-09-20" } },
      { nombre: "consultar_disponibilidad", args: { fecha: "2026-09-17" } },
      { nombre: "consultar_disponibilidad", args: { fecha: "2026-10-30" } },
    ], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "x"), "Laura");
    expect(c.resultados[0]).toContain("sin horas libres");
    expect(c.resultados[1]).toContain("ya pasó");
    expect(c.resultados[2]).toContain("Solo agendo hasta 7 días");
  });
});

describe("Susana · confirmación en dos pasos", () => {
  it("proponer no escribe; confirmar en el MISMO mensaje se rechaza; confirmar en el siguiente agenda y deja bitácora con nombre y número", async () => {
    const c = armar();
    c.guion.push({ herramientas: [
      { nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "11:00", nombre: "Laura Pérez" } },
      { nombre: "confirmar_cambio" },
    ], texto: "¿Confirmo tu cita el vie 18 de sep 11:00?" });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "a las 11 por favor"), "Laura");
    expect(c.resultados[0]).toContain("Propuesta guardada (cita de Laura el vie 18 de sep 11:00)");
    expect(c.resultados[1]).toContain("Todavía no");
    expect(c.calendario.lista("primary")).toHaveLength(0);

    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }], texto: "Listo, quedó." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), "Laura");
    expect(c.resultados[2]).toMatch(/^Hecho: cita de Laura el vie 18 de sep 11:00/);
    const [ev] = c.calendario.lista("primary");
    expect(ev).toMatchObject({ inicio: "2026-09-18T17:00:00.000Z", fin: "2026-09-18T18:00:00.000Z", titulo: "Cita · Laura", privado: { telefono: CLIENTE, nombre: "Laura", agente: "Susana" } });
    expect((await c.repo.getConversacion("t1", "A", CLIENTE))?.citaPendiente).toBeNull();
    const linea = c.bitacora.find((l) => l.includes("cita.agendada"))!;
    expect(linea).toContain("quien=Laura");
    expect(linea).toContain("telefono=+521••••5678");
    expect(linea).toContain("rol=cliente");
  });

  it("sin propuesta previa, confirmar no hace nada; sin nombre, proponer lo pide", async () => {
    const c = armar();
    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }, { nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "11:00" } }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), null);
    expect(c.resultados[0]).toContain("No hay ningún cambio propuesto");
    expect(c.resultados[1]).toContain("Falta el nombre");
  });

  it("una hora ocupada no se puede proponer; devuelve las libres del día", async () => {
    const c = armar();
    c.calendario.agregar("primary", { inicio: "2026-09-18T17:00:00Z", fin: "2026-09-18T18:00:00Z" });
    c.guion.push({ herramientas: [{ nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "11:00", nombre: "Laura" } }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "x"), "Laura");
    expect(c.resultados[0]).toContain("Esa hora no está libre. Ese día hay: 09:00, 10:00, 12:00, 13:00");
  });
});

describe("Susana · privacidad y quién puede qué", () => {
  async function conCita(c: ReturnType<typeof armar>) {
    c.calendario.agregar("primary", { id: "ev_laura", inicio: "2026-09-18T17:00:00Z", fin: "2026-09-18T18:00:00Z", titulo: "Cita · Laura", privado: { telefono: CLIENTE, nombre: "Laura" } });
    c.calendario.agregar("primary", { id: "ev_pedro", inicio: "2026-09-18T18:00:00Z", fin: "2026-09-18T19:00:00Z", titulo: "Cita · Pedro", privado: { telefono: OTRO, nombre: "Pedro" } });
    c.calendario.agregar("primary", { id: "ev_medico", inicio: "2026-09-18T19:00:00Z", fin: "2026-09-18T20:00:00Z", titulo: "Revisión de frenos con el cuñado", privado: {} });
  }

  it("el cliente solo ve sus citas; el dueño ve hora y nombre de pila, nunca el título de eventos ajenos", async () => {
    const c = armar();
    await conCita(c);
    c.guion.push({ herramientas: [{ nombre: "consultar_citas" }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "mis citas"), "Laura");
    expect(c.resultados[0]).toContain("id ev_laura");
    expect(c.resultados[0]).not.toContain("Pedro");
    expect(c.resultados[0]).not.toContain("ev_pedro");

    c.guion.push({ herramientas: [{ nombre: "consultar_citas", args: { fecha: "2026-09-18" } }], texto: "." });
    await c.agente.responder("t1", "A", entrante(DUENO.telefono, "qué tengo hoy"), "Raúl");
    const r = c.resultados[1]!;
    expect(r).toContain("11:00 · Laura");
    expect(r).toContain("12:00 · Pedro");
    expect(r).toContain("13:00 · ocupado");
    expect(r).not.toContain("frenos");
    expect(r).not.toContain(OTRO);
    expect(c.sistemas[1]).toContain("Raúl, dueño/admin del negocio");
  });

  it("un cliente no puede cancelar la cita de otro; sí la suya (con confirmación)", async () => {
    const c = armar();
    await conCita(c);
    c.guion.push({ herramientas: [
      { nombre: "proponer_cambio", args: { accion: "cancelar", evento_id: "ev_pedro" } },
      { nombre: "proponer_cambio", args: { accion: "cancelar", evento_id: "ev_laura" } },
    ], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "cancela"), "Laura");
    expect(c.resultados[0]).toContain("no es de este número");
    expect(c.resultados[1]).toContain("Propuesta guardada (cancelar la cita del vie 18 de sep 11:00 de Laura)");
    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), "Laura");
    expect(c.calendario.lista("primary").map((e) => e.id)).toEqual(["ev_pedro", "ev_medico"]);
    expect(c.bitacora.some((l) => l.includes("cita.cancelada") && l.includes("quien=Laura") && l.includes("evento=ev_laura"))).toBe(true);
  });

  it("mover: confirma y cambia el horario del evento", async () => {
    const c = armar();
    await conCita(c);
    c.guion.push({ herramientas: [{ nombre: "proponer_cambio", args: { accion: "mover", evento_id: "ev_laura", fecha: "2026-09-19", hora: "09:00" } }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "muévela"), "Laura");
    expect(c.resultados[0]).toContain("mover la cita del vie 18 de sep 11:00 al sáb 19 de sep 09:00");
    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), "Laura");
    expect(c.resultados[1]).toMatch(/^Hecho: mover/);
    expect(c.calendario.lista("primary").find((e) => e.id === "ev_laura")?.inicio).toBe("2026-09-19T15:00:00.000Z");
    expect(c.bitacora.some((l) => l.includes("cita.movida") && l.includes("desde=2026-09-18T17:00:00Z"))).toBe(true);
  });
});

describe("Susana · anti-empalme: Susana cede", () => {
  it("si alguien agendó por fuera entre la relectura y la escritura, borra su evento, registra cita.empalme y ofrece otras horas", async () => {
    const c = armar();
    c.guion.push({ herramientas: [{ nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "11:00", nombre: "Laura" } }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "11"), "Laura");
    // Carrera: el dueño mete a mano una cita a las 11 justo después de nuestro insert.
    c.calendario.alInsertar = (cal) => { c.calendario.agregar(cal, { inicio: "2026-09-18T17:00:00Z", fin: "2026-09-18T18:00:00Z", titulo: "Cliente de mostrador" }); c.calendario.alInsertar = null; };
    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), "Laura");
    expect(c.resultados[1]).toContain("Alguien acaba de ocupar esa hora");
    expect(c.resultados[1]).toContain("Ese día quedan: 09:00, 10:00, 12:00");
    const restantes = c.calendario.lista("primary");
    expect(restantes).toHaveLength(1);
    expect(restantes[0]!.titulo).toBe("Cliente de mostrador");
    const linea = c.bitacora.find((l) => l.includes("cita.empalme"))!;
    expect(linea).toContain("resultado=cedido");
    expect(linea).toContain("quien=Laura");
  });

  it("dos conversaciones nuestras por la misma hora: el candado deja pasar una", async () => {
    const c = armar();
    for (const tel of [CLIENTE, OTRO]) {
      c.guion.push({ herramientas: [{ nombre: "proponer_cambio", args: { accion: "agendar", fecha: "2026-09-18", hora: "11:00", nombre: tel === CLIENTE ? "Laura" : "Pedro" } }], texto: "." });
      await c.agente.responder("t1", "A", entrante(tel, "11"), null);
    }
    // Ambas confirman; la segunda relee el calendario y ya está ocupado.
    c.guion.push({ herramientas: [{ nombre: "confirmar_cambio" }], texto: "." }, { herramientas: [{ nombre: "confirmar_cambio" }], texto: "." });
    await c.agente.responder("t1", "A", entrante(CLIENTE, "sí"), null);
    await c.agente.responder("t1", "A", entrante(OTRO, "sí"), null);
    expect(c.calendario.lista("primary")).toHaveLength(1);
    expect(c.resultados[3]).toContain("se acaba de ocupar");
  });
});

describe("Susana · masivo, modo cliente y sin calendario", () => {
  it("'cancela todas' va a pasar_a_humano: ninguna herramienta de citas lo hace", async () => {
    const c = armar();
    c.guion.push({ herramientas: [{ nombre: "pasar_a_humano", args: { motivo: "otro", resumen: "Pide cancelar todas las citas de mañana." } }], texto: "Le paso con una persona." });
    await c.agente.responder("t1", "A", entrante(DUENO.telefono, "cancela todas mis citas de mañana"), "Raúl");
    expect(c.resultados[0]).toContain("una persona del equipo seguirá");
    expect((await c.repo.getConversacion("t1", "A", DUENO.telefono))?.traspaso?.motivo).toBe("otro");
    expect(c.sistemas[0]).toContain("más de una cita");
  });

  it("'modo cliente' cambia el trato del número del directorio sin pasar por el modelo, y 'salir de modo cliente' lo regresa", async () => {
    const c = armar();
    const r1 = await c.agente.responder("t1", "A", entrante(DUENO.telefono, "Modo cliente"), "Raúl");
    expect(r1.texto).toContain(`durante ${MODO_CLIENTE_HORAS} horas te atiendo como cliente`);
    expect(c.sistemas).toHaveLength(0);
    c.guion.push({ texto: "." });
    await c.agente.responder("t1", "A", entrante(DUENO.telefono, "quiero una cita"), "Raúl");
    expect(c.sistemas[0]).toContain("MODO CLIENTE");
    c.avanzar(MODO_CLIENTE_HORAS * 3_600_000 + 1);
    c.guion.push({ texto: "." });
    await c.agente.responder("t1", "A", entrante(DUENO.telefono, "qué tengo hoy"), "Raúl");
    expect(c.sistemas[1]).toContain("Raúl, dueño/admin");
    expect((await c.agente.responder("t1", "A", entrante(DUENO.telefono, "salir de modo cliente"), "Raúl")).texto).toContain("vuelves a ser dueño/admin");
    expect((await c.agente.responder("t1", "A", entrante(CLIENTE, "modo cliente"), "Laura")).texto).toBe("ok"); // no está en el directorio: no es comando
  });

  it("sin Google conectado no contesta y lo dice en bitácora", async () => {
    const c = armar();
    await c.repo.deleteConectorGoogle("t1");
    expect((await c.agente.responder("t1", "A", entrante(CLIENTE, "hola"), "Laura")).texto).toBeNull();
    expect(c.bitacora.some((l) => l.includes("agente.sin_calendario") && l.includes("no ha conectado"))).toBe(true);
  });
});
