import { afterEach, describe, expect, it } from "vitest";
import type { FotoPrecios, Tenant } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { Cobrador } from "../cobro/cobrador.ts";
import { CargadorPrecios } from "../cobro/precios.ts";
import { cargarConfigPrecios } from "../cobro/config-precios.ts";
import type { ClienteStripe, EventoStripe, ResultadoCobro } from "../cobro/stripe.ts";
import { clientIdDeCookie, GA4Real, type Analitica, type EventoConversion } from "./ga4.ts";

const FOTO: FotoPrecios = {
  version: "prueba", IVA: 0.16, PRECIO_PLAN: { basico: 599, estandar: 1199, pro: 2200 }, LINEAS_INCLUIDAS: 1,
  LINEA_ADICIONAL: { precioHasta4: 499, precioDesde5: 429, umbral: 5 }, AGENTE: { incluidosEnPro: 1, bolsaApiMensual: 200, adicional: 550 },
  PERIODOS: { mensual: { nombre: "Mensual", meses: 1, descuento: 0 }, semestral: { nombre: "Semestral", meses: 6, descuento: 0.1 }, anual: { nombre: "Anual", meses: 12, descuento: 0.25 } },
};
const PRICES = Object.fromEntries(["BASICO", "ESTANDAR", "PRO"].flatMap((p) => ["MENSUAL", "SEMESTRAL", "ANUAL"].map((q) => [`STRIPE_PRICE_${p}_${q}`, `price_${p}_${q}`.toLowerCase()])));

class StripeFalso implements ClienteStripe {
  readonly modo = "test" as const;
  sesiones: any[] = [];
  eventos = new Map<string, EventoStripe>();
  async asegurarCliente(t: string) { return `cus_${t}`; }
  async crearSetupIntent() { return { id: "seti", clientSecret: "x" }; }
  async metodoDePago(id: string) { return { id, marca: "visa", ultimos4: "4242", vence: "2030-01" }; }
  async fijarMetodoPorDefecto() {}
  async cobrar(): Promise<ResultadoCobro> { return { id: "pi", estado: "succeeded", codigoError: null, mensajeError: null, clientSecret: null }; }
  async crearCheckoutSession(o: any) { this.sesiones.push(o); return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" }; }
  async crearPortalSession() { return { url: "https://billing.stripe.com/x" }; }
  async obtenerSuscripcion() { return { status: "active", cancelAtPeriodEnd: false, trialEnd: null }; }
  construirEvento(cuerpo: Buffer | string, firma: string): EventoStripe {
    if (firma !== "ok") throw new Error("firma");
    return this.eventos.get(String(cuerpo))!;
  }
}

class AnaliticaFalsa implements Analitica {
  readonly activa = true;
  eventos: { clientId: string | null | undefined; nombre: EventoConversion; params: Record<string, string | number> }[] = [];
  async evento(clientId: string | null | undefined, nombre: EventoConversion, params: Record<string, string | number>) { this.eventos.push({ clientId, nombre, params }); }
}

const TENANT: Tenant = { id: "t1", nombre: "Taller", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-10-01T00:00:00Z" };

function armar() {
  const repo = new RepositorioEnMemoria({ tenants: [TENANT] });
  const stripe = new StripeFalso();
  const analitica = new AnaliticaFalsa();
  const cobrador = new Cobrador({ repo, stripe, analitica, configPrecios: cargarConfigPrecios(PRICES), precios: new CargadorPrecios({ url: null, inicial: FOTO }), ahora: () => Date.parse("2026-10-12T12:00:00Z") });
  const bitacora: string[] = [];
  usarSalida((_n, l) => { bitacora.push(l); });
  return { repo, stripe, analitica, cobrador, bitacora };
}
afterEach(() => usarSalida(null));

describe("clientIdDeCookie", () => {
  it("extrae el client_id de la cookie _ga y acepta el id limpio; rechaza basura", () => {
    expect(clientIdDeCookie("GA1.1.123456789.1700000000")).toBe("123456789.1700000000");
    expect(clientIdDeCookie("123456789.1700000000")).toBe("123456789.1700000000");
    expect(clientIdDeCookie("GA1.2.1.2")).toBe("1.2");
    expect(clientIdDeCookie("")).toBeNull();
    expect(clientIdDeCookie("<script>")).toBeNull();
    expect(clientIdDeCookie(undefined)).toBeNull();
  });
});

describe("conversiones GA4 desde el cobro", () => {
  it("checkout: guarda plan, periodo, meses y ga4ClientId en la metadata de la sesión y de la suscripción, y manda checkout_iniciado", async () => {
    const { stripe, analitica, cobrador } = armar();
    await cobrador.iniciarSuscripcion("t1", "estandar", "anual", { success: "https://x/ok", cancel: "https://x/no" }, { ga4ClientId: "GA1.1.555.666" });
    expect(stripe.sesiones[0].metadata).toEqual({ plan: "estandar", periodo: "anual", meses: "12", ga4ClientId: "555.666" });
    expect(analitica.eventos).toEqual([{ clientId: "555.666", nombre: "checkout_iniciado", params: { plan: "estandar", periodicidad: "anual", modo: "test" } }]);
  });

  it("checkout sin cookie: metadata sin ga4ClientId; el evento llega con client_id nulo y GA4Real lo registra sin mandar", async () => {
    const { stripe, cobrador, analitica } = armar();
    await cobrador.iniciarSuscripcion("t1", "pro", "mensual", { success: "https://x/ok", cancel: "https://x/no" });
    expect(stripe.sesiones[0].metadata).toEqual({ plan: "pro", periodo: "mensual", meses: "1" });
    expect(analitica.eventos[0]?.clientId).toBeNull();
  });

  it("checkout.session.completed → prueba_iniciada; invoice.paid con monto → suscripcion_activa y cobertura de 12 meses en anual", async () => {
    const { stripe, cobrador, analitica, repo } = armar();
    const meta = { tenantId: "t1", plan: "estandar", periodo: "anual", meses: "12", ga4ClientId: "555.666" };
    stripe.eventos.set("cs", { id: "evt_1", tipo: "checkout.session.completed", objeto: { id: "cs_1", subscription: "sub_1", customer: "cus_t1", metadata: meta } });
    expect((await cobrador.procesarWebhook("cs", "ok")).accion).toBe("suscripcion_vinculada");
    stripe.eventos.set("inv0", { id: "evt_2", tipo: "invoice.paid", objeto: { id: "in_0", subscription: "sub_1", amount_paid: 0, subscription_details: { metadata: meta } } });
    expect((await cobrador.procesarWebhook("inv0", "ok")).accion).toBe("factura_trial");
    stripe.eventos.set("inv1", { id: "evt_3", tipo: "invoice.paid", objeto: { id: "in_1", subscription: "sub_1", amount_paid: 1251216, subscription_details: { metadata: meta }, lines: { data: [{ metadata: meta }] } } });
    expect((await cobrador.procesarWebhook("inv1", "ok")).accion).toBe("pago_registrado");
    // Reenvío del mismo evento: ni pago ni evento duplicados.
    expect((await cobrador.procesarWebhook("inv1", "ok")).accion).toBe("pago_ya_registrado");

    expect(analitica.eventos.map((e) => e.nombre)).toEqual(["prueba_iniciada", "suscripcion_activa"]);
    expect(analitica.eventos[0]).toEqual({ clientId: "555.666", nombre: "prueba_iniciada", params: { plan: "estandar", periodicidad: "anual" } });
    expect(analitica.eventos[1]).toEqual({ clientId: "555.666", nombre: "suscripcion_activa", params: { plan: "estandar", periodicidad: "anual", value: 12512.16, currency: "MXN", transaction_id: "in_1" } });
    const [pago] = await repo.listPagos("t1");
    expect(pago).toMatchObject({ periodo: "anual", meses: 12, montoMxn: 12512.16 });
  });

  it("invoice.paid sin periodo en metadata (suscripciones creadas antes de hoy) sigue registrando 1 mes, como antes", async () => {
    const { stripe, cobrador, repo } = armar();
    stripe.eventos.set("inv", { id: "evt_9", tipo: "invoice.paid", objeto: { id: "in_9", subscription: "sub_9", amount_paid: 139084, subscription_details: { metadata: { tenantId: "t1" } } } });
    expect((await cobrador.procesarWebhook("inv", "ok")).accion).toBe("pago_registrado");
    expect((await repo.listPagos("t1"))[0]).toMatchObject({ periodo: null, meses: 1 });
  });
});

describe("GA4Real", () => {
  it("manda el evento al Protocolo de Medición con el client_id y nunca lanza", async () => {
    const llamadas: { url: string; body: any }[] = [];
    const g = new GA4Real({ measurementId: "G-TEST", apiSecret: "s3cr3t", fetchImpl: (async (url: any, init: any) => { llamadas.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("", { status: 204 }); }) as typeof fetch });
    await g.evento("GA1.1.1.2", "suscripcion_activa", { plan: "pro", periodicidad: "mensual", value: 2552, currency: "MXN" });
    expect(llamadas[0]!.url).toBe("https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cr3t");
    expect(llamadas[0]!.body).toEqual({ client_id: "1.2", non_personalized_ads: true, events: [{ name: "suscripcion_activa", params: { plan: "pro", periodicidad: "mensual", value: 2552, currency: "MXN" } }] });
    const bitacora: string[] = [];
    usarSalida((_n, l) => { bitacora.push(l); });
    const roto = new GA4Real({ measurementId: "G-TEST", apiSecret: "s", fetchImpl: (async () => { throw new Error("red caída"); }) as typeof fetch });
    await expect(roto.evento("1.2", "checkout_iniciado", { plan: "basico" })).resolves.toBeUndefined();
    expect(bitacora.some((l) => l.includes("ga4.error"))).toBe(true);
    await roto.evento(null, "checkout_iniciado", { plan: "basico" });
    expect(bitacora.some((l) => l.includes("ga4.sin_client_id"))).toBe(true);
  });
});
