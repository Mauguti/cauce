import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FotoPrecios } from "@cauce/core";
import { crearApp } from "../app.ts";
import { hashApiKey } from "../auth.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { Cobrador } from "./cobrador.ts";
import { CargadorPrecios } from "./precios.ts";
import type { ClienteStripe, EventoStripe, ResultadoCobro } from "./stripe.ts";

const KEY = "key-tenant-a-0000000000000000";
const FOTO: FotoPrecios = {
  version: "prueba", IVA: 0.16,
  PRECIO_PLAN: { basico: 599, estandar: 1199, pro: 2200 }, LINEAS_INCLUIDAS: 1,
  LINEA_ADICIONAL: { precioHasta4: 499, precioDesde5: 429, umbral: 5 }, AGENTE: { incluidosEnPro: 1, bolsaApiMensual: 200, adicional: 550 },
  PERIODOS: { mensual: { nombre: "Mensual", meses: 1, descuento: 0 }, semestral: { nombre: "Semestral", meses: 6, descuento: 0.1 }, anual: { nombre: "Anual", meses: 12, descuento: 0.25 } },
};

class StripeFalso implements ClienteStripe {
  readonly modo = "test" as const;
  eventos = new Map<string, EventoStripe>();
  async asegurarCliente(t: string) { return `cus_${t}`; }
  async crearSetupIntent() { return { id: "seti_1", clientSecret: "seti_1_secret_x" }; }
  async metodoDePago(id: string) { return { id, marca: "visa", ultimos4: "4242", vence: "2028-03" }; }
  async fijarMetodoPorDefecto() {}
  async cobrar(): Promise<ResultadoCobro> { return { id: "pi_1", estado: "succeeded", codigoError: null, mensajeError: null, clientSecret: null }; }
  construirEvento(cuerpo: Buffer | string, firma: string): EventoStripe {
    if (firma !== "firma-ok") throw new Error("No signatures found matching the expected signature for payload");
    const ev = this.eventos.get(cuerpo.toString());
    if (!ev) throw new Error("evento desconocido");
    return ev;
  }
}

const bitacora: string[] = [];
usarSalida((_n, l) => { bitacora.push(l); });
afterEach(() => { bitacora.length = 0; });

function levantar(opciones: { conCobrador?: boolean } = {}) {
  const repo = new RepositorioEnMemoria({
    tenants: [{ id: "a", nombre: "A", plan: "estandar", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2028-09-05T00:00:00Z", pagadoHasta: "2028-09-20T00:00:00.000Z", cicloCorteEn: "2028-09-20T00:00:00.000Z" }],
  });
  const stripe = new StripeFalso();
  const cobrador = new Cobrador({ repo, stripe, precios: new CargadorPrecios({ url: null, inicial: FOTO }), ahora: () => Date.parse("2028-09-15T12:00:00Z") });
  const server = crearApp(repo, undefined, { adminKey: "admin-secreta", ...(opciones.conCobrador === false ? {} : { cobrador }) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, repo, stripe, cerrar: () => server.close() };
}
const conKey = { headers: { "x-api-key": KEY, "content-type": "application/json" } };

describe("rutas de cobro", () => {
  it("POST /webhooks/stripe: sin firma 400 y registrado; con firma válida procesa sobre el cuerpo crudo", async () => {
    const { base, stripe, repo, cerrar } = levantar();
    try {
      const sin = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "payment_intent.succeeded" }) });
      expect(sin.status).toBe(400);
      const mala = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=xx" }, body: "{}" });
      expect(mala.status).toBe(400);
      expect(bitacora.filter((l) => l.includes("stripe.webhook_rechazado"))).toHaveLength(2);
      expect(await repo.listPagos("a")).toHaveLength(0);

      const cuerpo = '{"id":"evt_1","type":"payment_intent.succeeded"}';
      stripe.eventos.set(cuerpo, { id: "evt_1", tipo: "payment_intent.succeeded", objeto: { id: "pi_9", amount_received: 139084, metadata: { tenantId: "a", periodo: "mensual", meses: "1" } } });
      const ok = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "firma-ok" }, body: cuerpo });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ recibido: true, tipo: "payment_intent.succeeded", accion: "pago_registrado" });
      expect((await repo.getTenant("a"))!.pagadoHasta).toBe("2028-10-20T00:00:00.000Z");
    } finally {
      cerrar();
    }
  });

  it("sin cobrador: webhook 503 registrado, rutas de cobro 503", async () => {
    const { base, cerrar } = levantar({ conCobrador: false });
    try {
      const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body: "{}" });
      expect(r.status).toBe(503);
      expect(bitacora.some((l) => l.includes("stripe.webhook_rechazado") && l.includes("cobrador sin configurar"))).toBe(true);
      expect((await fetch(`${base}/api/tenants/a/cobro`, conKey)).status).toBe(503);
      expect((await fetch(`${base}/health`).then((x) => x.json())).stripe).toBeNull();
    } finally {
      cerrar();
    }
  });

  it("GET/PUT /cobro, POST /cobro/setup-intent y GET /pagos con auth de tenant; /health expone el modo", async () => {
    const { base, cerrar } = levantar();
    try {
      expect((await fetch(`${base}/health`).then((x) => x.json())).stripe).toBe("test");
      expect((await fetch(`${base}/api/tenants/a/cobro`)).status).toBe(401);
      const estado = await fetch(`${base}/api/tenants/a/cobro`, conKey).then((x) => x.json());
      expect(estado).toMatchObject({ modo: "transferencia", periodo: "mensual", lineasContratadas: 1, metodo: null, stripe: "test", estadoPago: "al_corriente" });
      expect(estado.proximoCobro.total).toBe(1390.84);
      expect(estado).not.toHaveProperty("stripeCustomerId");

      const put = await fetch(`${base}/api/tenants/a/cobro`, { ...conKey, method: "PUT", body: JSON.stringify({ periodo: "semestral", lineasContratadas: 7 }) });
      expect(put.status).toBe(200);
      const despues = await fetch(`${base}/api/tenants/a/cobro`, conKey).then((x) => x.json());
      expect(despues.proximoCobro).toMatchObject({ subtotalMensual: 3773, meses: 6, descuento: 0.1 });
      expect(despues.proximoCobro.total).toBe(Math.round(3773 * 6 * 0.9 * 1.16 * 100) / 100);

      const tarjeta = await fetch(`${base}/api/tenants/a/cobro`, { ...conKey, method: "PUT", body: JSON.stringify({ modo: "tarjeta" }) });
      expect(tarjeta.status).toBe(409);

      const si = await fetch(`${base}/api/tenants/a/cobro/setup-intent`, { ...conKey, method: "POST" });
      expect(si.status).toBe(200);
      expect(await si.json()).toEqual({ clientSecret: "seti_1_secret_x", modo: "test" });

      const pagos = await fetch(`${base}/api/tenants/a/pagos`, conKey).then((x) => x.json());
      expect(pagos).toEqual([]);
    } finally {
      cerrar();
    }
  });

  it("admin: transferencia por folio/monto/periodo deriva la fecha; ya no acepta pagadoHasta; reembolso por referencia", async () => {
    const { base, repo, cerrar } = levantar();
    const admin = { headers: { "x-admin-key": "admin-secreta", "content-type": "application/json" } };
    try {
      expect((await fetch(`${base}/api/admin/tenants/a/pago`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      const viejo = await fetch(`${base}/api/admin/tenants/a/pago`, { ...admin, method: "POST", body: JSON.stringify({ pagadoHasta: "2029-01-01T00:00:00Z" }) });
      expect(viejo.status).toBe(400);
      const r = await fetch(`${base}/api/admin/tenants/a/pago`, { ...admin, method: "POST", body: JSON.stringify({ folio: "BBVA-123", montoMxn: 1390.84, periodo: "mensual", registradoPor: "mau" }) });
      expect(r.status).toBe(201);
      const cuerpo = await r.json();
      expect(cuerpo.pagadoHasta).toBe("2028-10-20T00:00:00.000Z");
      expect(cuerpo.pago).toMatchObject({ fuente: "transferencia", referencia: "BBVA-123", registradoPor: "admin:mau", cfdi: { estado: "pendiente" } });
      const otraVez = await fetch(`${base}/api/admin/tenants/a/pago`, { ...admin, method: "POST", body: JSON.stringify({ folio: "BBVA-123", montoMxn: 1390.84, periodo: "mensual" }) });
      expect(otraVez.status).toBe(200);
      expect((await otraVez.json()).nuevo).toBe(false);
      expect((await repo.getTenant("a"))!.pagadoHasta).toBe("2028-10-20T00:00:00.000Z");

      const re = await fetch(`${base}/api/admin/tenants/a/reembolso`, { ...admin, method: "POST", body: JSON.stringify({ referencia: "DEV-1", referenciaPago: "BBVA-123", montoMxn: 1390.84, fuente: "transferencia", registradoPor: "mau" }) });
      expect(re.status).toBe(201);
      expect((await re.json()).pagadoHasta).toBe("2028-09-20T00:00:00.000Z");
      const ledger = await fetch(`${base}/api/tenants/a/pagos`, conKey).then((x) => x.json());
      expect(ledger.map((p: any) => p.montoMxn).sort((x: number, y: number) => x - y)).toEqual([-1390.84, 1390.84]);
    } finally {
      cerrar();
    }
  });
});
