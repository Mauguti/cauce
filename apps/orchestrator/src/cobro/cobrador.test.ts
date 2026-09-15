import { afterEach, describe, expect, it } from "vitest";
import { calcularCobro, sumarMeses, type FotoPrecios, type Tenant } from "@cauce/core";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";
import { Cobrador, ErrorFirmaStripe, MESES_PERIODO } from "./cobrador.ts";
import { CargadorPrecios, validarFoto } from "./precios.ts";
import type { ClienteStripe, EventoStripe, ResultadoCobro } from "./stripe.ts";

/** Misma tabla que lib/precios.ts de la plataforma (13-sep-2026). */
const FOTO: FotoPrecios = {
  version: "prueba",
  IVA: 0.16,
  PRECIO_PLAN: { basico: 599, estandar: 1199, pro: 2200 },
  LINEAS_INCLUIDAS: 1,
  LINEA_ADICIONAL: { precioHasta4: 499, precioDesde5: 429, umbral: 5 },
  AGENTE: { incluidosEnPro: 1, bolsaApiMensual: 200, adicional: 550 },
  PERIODOS: { mensual: { nombre: "Mensual", meses: 1, descuento: 0 }, semestral: { nombre: "Semestral", meses: 6, descuento: 0.1 }, anual: { nombre: "Anual", meses: 12, descuento: 0.25 } },
};

const DIA = 86_400_000;
const T0 = Date.parse("2026-09-15T12:00:00Z");

function tenant(extra: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1", nombre: "Digsol", plan: "estandar", estado: "activo", apiKeyHash: "x".repeat(64), creadoEn: "2026-09-01T00:00:00Z",
    pagadoHasta: "2026-09-15T00:00:00Z", cicloCorteEn: "2026-09-15T00:00:00Z",
    cobro: { modo: "tarjeta", periodo: "mensual", lineasContratadas: 7, stripeCustomerId: "cus_1", metodo: { id: "pm_1", marca: "visa", ultimos4: "4242", vence: "2028-03" }, intentos: null, actualizadoEn: "2026-09-01T00:00:00Z" },
    ...extra,
  };
}

class StripeFalso implements ClienteStripe {
  readonly modo = "test" as const;
  cobros: any[] = [];
  respuestas: ResultadoCobro[] = [];
  eventos = new Map<string, EventoStripe>();
  firmaValida = "firma-ok";
  async asegurarCliente(tenantId: string): Promise<string> { return `cus_${tenantId}`; }
  async crearSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }> { return { id: "seti_1", clientSecret: `seti_1_secret_${customerId}` }; }
  async metodoDePago(id: string) { return { id, marca: "visa", ultimos4: "4242", vence: "2028-03" }; }
  async fijarMetodoPorDefecto(): Promise<void> {}
  async cobrar(o: any): Promise<ResultadoCobro> {
    this.cobros.push(o);
    return this.respuestas.shift() ?? { id: `pi_${this.cobros.length}`, estado: "succeeded", codigoError: null, mensajeError: null, clientSecret: null };
  }
  construirEvento(cuerpo: Buffer | string, firma: string): EventoStripe {
    if (firma !== this.firmaValida) throw new Error("No signatures found matching the expected signature for payload");
    const ev = this.eventos.get(String(cuerpo));
    if (!ev) throw new Error("evento desconocido en el falso");
    return ev;
  }
}

function armar(opciones: { tenants?: Tenant[]; foto?: FotoPrecios | null; avisos?: string[] } = {}) {
  const repo = new RepositorioEnMemoria({ tenants: opciones.tenants ?? [tenant()] });
  const stripe = new StripeFalso();
  let ahora = T0;
  const precios = new CargadorPrecios({ url: null, ...(opciones.foto === null ? {} : { inicial: opciones.foto ?? FOTO }) });
  const cobrador = new Cobrador({ repo, stripe, precios, ahora: () => ahora, ...(opciones.avisos ? { avisar: async (_t, texto) => { opciones.avisos!.push(texto); } } : {}) });
  return { repo, stripe, cobrador, avanzar: (ms: number) => { ahora += ms; } };
}

const bitacora: string[] = [];
usarSalida((_n, l) => { bitacora.push(l); });
afterEach(() => { bitacora.length = 0; });

describe("calcularCobro: misma regla que lib/precios.ts", () => {
  it("Procesa: Estándar con 7 líneas totales = $3,773 al mes; IVA 16 %", () => {
    const d = calcularCobro(FOTO, { plan: "estandar", lineasTotales: 7, agentesAdicionales: 0, periodo: "mensual" });
    expect(d.lineasAdicionales).toBe(6);
    expect(d.precioLineaAdicional).toBe(429);
    expect(d.subtotalMensual).toBe(3773);
    expect(d.iva).toBe(603.68);
    expect(d.total).toBe(4376.68);
    expect(d.centavos).toBe(437668);
  });
  it("escalón: 4 adicionales a 499, 5 a 429 todas", () => {
    expect(calcularCobro(FOTO, { plan: "basico", lineasTotales: 5, agentesAdicionales: 0, periodo: "mensual" }).subtotalMensual).toBe(599 + 4 * 499);
    expect(calcularCobro(FOTO, { plan: "basico", lineasTotales: 6, agentesAdicionales: 0, periodo: "mensual" }).subtotalMensual).toBe(599 + 5 * 429);
  });
  it("anual −25 % sobre el periodo completo, agente adicional 550", () => {
    const d = calcularCobro(FOTO, { plan: "pro", lineasTotales: 1, agentesAdicionales: 1, periodo: "anual" });
    expect(d.subtotalMensual).toBe(2750);
    expect(d.subtotalPeriodo).toBe(24750);
    expect(d.total).toBe(28710);
    expect(d.meses).toBe(12);
  });
  it("sumarMeses recorta al fin de mes", () => {
    expect(sumarMeses("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
    expect(sumarMeses("2026-09-15T00:00:00.000Z", 6)).toBe("2027-03-15T00:00:00.000Z");
    expect(sumarMeses("2026-09-15T00:00:00.000Z", -1)).toBe("2026-08-15T00:00:00.000Z");
  });
  it("validarFoto rechaza una foto incompleta", () => {
    expect(() => validarFoto({ ...FOTO, PRECIO_PLAN: { basico: 0 } })).toThrow(/PRECIO_PLAN/);
    expect(() => validarFoto(null)).toThrow();
    expect(validarFoto(FOTO)).toEqual(FOTO);
  });
});

describe("registrarPago: único camino a pagadoHasta", () => {
  it("renovación suma desde pagadoHasta vigente; regularización desde hoy", async () => {
    const { repo, cobrador } = armar({ tenants: [tenant({ pagadoHasta: "2026-09-20T00:00:00.000Z" })] });
    const r1 = await cobrador.registrarTransferencia("t1", { folio: "F-1", montoMxn: 1390.84, periodo: "mensual", registradoPor: "admin:mau" });
    expect(r1.nuevo).toBe(true);
    expect(r1.pago.pagadoHastaDespues).toBe("2026-10-20T00:00:00.000Z");
    const t = (await repo.getTenant("t1"))!;
    expect(t.pagadoHasta).toBe("2026-10-20T00:00:00.000Z");
    expect(t.cicloCorteEn).toBe("2026-10-20T00:00:00.000Z");

    const vencido = armar({ tenants: [tenant({ pagadoHasta: "2026-08-01T00:00:00.000Z" })] });
    const r2 = await vencido.cobrador.registrarTransferencia("t1", { folio: "F-2", montoMxn: 1390.84, periodo: "semestral", registradoPor: "admin:mau" });
    expect(r2.pago.pagadoHastaDespues).toBe("2027-03-15T12:00:00.000Z");
    expect(r2.pago.meses).toBe(MESES_PERIODO.semestral);
    expect(bitacora.some((l) => l.includes("pago.registrado") && l.includes("fuente=transferencia"))).toBe(true);
  });

  it("es idempotente por referencia: el segundo registro no escribe ni mueve la fecha", async () => {
    const { repo, cobrador } = armar();
    await cobrador.registrarTransferencia("t1", { folio: "F-9", montoMxn: 100, periodo: "mensual", registradoPor: "admin:mau" });
    const r = await cobrador.registrarTransferencia("t1", { folio: "F-9", montoMxn: 100, periodo: "mensual", registradoPor: "admin:otro" });
    expect(r.nuevo).toBe(false);
    expect((await repo.listPagos("t1")).length).toBe(1);
    expect((await repo.getTenant("t1"))!.pagadoHasta).toBe("2026-10-15T00:00:00.000Z");
  });

  it("reembolso: fila negativa que recorta pagadoHasta los meses devueltos; nunca borra", async () => {
    const { repo, cobrador } = armar({ tenants: [tenant({ pagadoHasta: "2026-09-20T00:00:00.000Z" })] });
    await cobrador.registrarPago("t1", { fuente: "stripe", tipo: "pago", referencia: "pi_A", montoMxn: 7000, periodo: "semestral", meses: 6, registradoPor: "stripe:webhook" });
    expect((await repo.getTenant("t1"))!.pagadoHasta).toBe("2027-03-20T00:00:00.000Z");
    // Reembolso completo
    const r = await cobrador.registrarReembolso("t1", { referencia: "re_1", montoMxn: 7000, referenciaPago: "pi_A", fuente: "stripe", registradoPor: "admin:mau" });
    expect(r?.nuevo).toBe(true);
    expect(r?.pago.montoMxn).toBe(-7000);
    expect(r?.pago.meses).toBe(-6);
    expect((await repo.getTenant("t1"))!.pagadoHasta).toBe("2026-09-20T00:00:00.000Z");
    // Reembolso parcial (la mitad) sobre otro pago
    await cobrador.registrarPago("t1", { fuente: "stripe", tipo: "pago", referencia: "pi_B", montoMxn: 7000, periodo: "semestral", meses: 6, registradoPor: "stripe:webhook" });
    const parcial = await cobrador.registrarReembolso("t1", { referencia: "re_2", montoMxn: 3500, referenciaPago: "pi_B", fuente: "stripe", registradoPor: "admin:mau" });
    expect(parcial?.pago.meses).toBe(-3);
    expect((await repo.getTenant("t1"))!.pagadoHasta).toBe("2026-12-20T00:00:00.000Z");
    const ledger = await repo.listPagos("t1");
    expect(ledger).toHaveLength(4);
    expect(ledger.every((p) => p.cfdi.estado === "pendiente")).toBe(true);
    // Reembolso sin pago original: no inventa nada
    expect(await cobrador.registrarReembolso("t1", { referencia: "re_3", montoMxn: 1, referenciaPago: "pi_NO", fuente: "stripe", registradoPor: "admin" })).toBeNull();
  });
});

describe("cobrarCortes", () => {
  it("cobra el corte vencido con clave de idempotencia tenant:corte, monto de la foto, y registra el pago", async () => {
    const { repo, stripe, cobrador } = armar();
    expect(await cobrador.cobrarCortes()).toBe(1);
    expect(stripe.cobros).toHaveLength(1);
    expect(stripe.cobros[0].idempotencia).toBe("t1:2026-09-15T00:00:00Z");
    expect(stripe.cobros[0].centavos).toBe(437668);
    expect(stripe.cobros[0].metadata.tenantId).toBe("t1");
    const t = (await repo.getTenant("t1"))!;
    expect(t.pagadoHasta).toBe("2026-10-15T00:00:00.000Z");
    expect(t.cicloCorteEn).toBe("2026-10-15T00:00:00.000Z");
    const [pago] = await repo.listPagos("t1");
    expect(pago!.fuente).toBe("stripe");
    expect(pago!.fotoPrecios?.hash).toBeTruthy();
    expect(pago!.montoMxn).toBe(4376.68);
    // Segunda corrida: ya no hay corte vencido
    expect(await cobrador.cobrarCortes()).toBe(0);
    expect(stripe.cobros).toHaveLength(1);
  });

  it("sin foto de precios no cobra y avisa", async () => {
    const avisos: string[] = [];
    const { stripe, cobrador } = armar({ foto: null, avisos });
    expect(await cobrador.cobrarCortes()).toBe(0);
    expect(stripe.cobros).toHaveLength(0);
    expect(avisos[0]).toContain("No hay foto de precios");
    expect(bitacora.some((l) => l.includes("cobro.sin_precios"))).toBe(true);
  });

  it("no cobra a tenants por transferencia, en prueba, sin tarjeta o con corte futuro", async () => {
    const { stripe, cobrador } = armar({ tenants: [
      tenant({ id: "a", cobro: { ...tenant().cobro!, modo: "transferencia" } }),
      tenant({ id: "b", plan: "prueba" }),
      tenant({ id: "c", cobro: { ...tenant().cobro!, metodo: null } }),
      tenant({ id: "d", cicloCorteEn: "2026-09-16T00:00:00Z" }),
    ] });
    expect(await cobrador.cobrarCortes()).toBe(0);
    expect(stripe.cobros).toHaveLength(0);
  });

  it("falla: reintenta a +3 y +7 días con la misma clave; al tercer fallo se agota y avisa; la suspensión no se toca", async () => {
    const avisos: string[] = [];
    const { repo, stripe, cobrador, avanzar } = armar({ avisos });
    const fallo = (): ResultadoCobro => ({ id: "pi_x", estado: "failed", codigoError: "card_declined", mensajeError: "Your card was declined.", clientSecret: null });
    stripe.respuestas.push(fallo(), fallo(), fallo());
    expect(await cobrador.cobrarCortes()).toBe(1);
    let t = (await repo.getTenant("t1"))!;
    expect(t.cobro?.intentos).toMatchObject({ corte: "2026-09-15T00:00:00Z", fallos: 1, ultimoError: "card_declined", agotado: false });
    expect(t.pagadoHasta).toBe("2026-09-15T00:00:00Z");
    // Día 1 y 2: no reintenta
    avanzar(1 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(0);
    // Día 3: segundo intento
    avanzar(2 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(1);
    // Día 5: nada; día 7: tercero y agotado
    avanzar(2 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(0);
    avanzar(2 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(1);
    t = (await repo.getTenant("t1"))!;
    expect(t.cobro?.intentos?.agotado).toBe(true);
    expect(t.estado).toBe("activo");
    expect(stripe.cobros.every((c) => c.idempotencia === "t1:2026-09-15T00:00:00Z")).toBe(true);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("cobro agotado");
    expect(avisos[0]).toContain("card_declined");
    expect(bitacora.some((l) => l.includes("cobro.agotado"))).toBe(true);
    // Día 8: agotado, no vuelve a intentar
    avanzar(1 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(0);
    expect(stripe.cobros).toHaveLength(3);
  });

  it("tarjeta vencida: retira el método y avisa desde el día 0", async () => {
    const avisos: string[] = [];
    const { repo, stripe, cobrador } = armar({ avisos });
    stripe.respuestas.push({ id: "pi_x", estado: "failed", codigoError: "expired_card", mensajeError: "expired", clientSecret: null });
    await cobrador.cobrarCortes();
    expect((await repo.getTenant("t1"))!.cobro?.metodo).toBeNull();
    expect(avisos[0]).toContain("sin tarjeta válida");
  });

  it("requiere acción del banco: guarda el client_secret y no reintenta a ciegas", async () => {
    const { repo, stripe, cobrador, avanzar } = armar();
    stripe.respuestas.push({ id: "pi_3ds", estado: "requires_action", codigoError: "authentication_required", mensajeError: null, clientSecret: "pi_3ds_secret" });
    await cobrador.cobrarCortes();
    expect((await repo.getTenant("t1"))!.cobro?.intentos?.requiereAccion).toBe("pi_3ds_secret");
    avanzar(10 * DIA);
    expect(await cobrador.cobrarCortes()).toBe(0);
    expect(stripe.cobros).toHaveLength(1);
  });

  it("tarjeta nueva por webhook limpia los intentos y el job vuelve a cobrar ese día", async () => {
    const { repo, stripe, cobrador } = armar();
    stripe.respuestas.push({ id: "pi_x", estado: "failed", codigoError: "card_declined", mensajeError: null, clientSecret: null });
    await cobrador.cobrarCortes();
    stripe.eventos.set("ev-seti", { id: "evt_1", tipo: "setup_intent.succeeded", objeto: { id: "seti_1", payment_method: "pm_nueva", customer: "cus_1", metadata: { tenantId: "t1" } } });
    const r = await cobrador.procesarWebhook("ev-seti", "firma-ok");
    expect(r.accion).toBe("metodo_guardado");
    const t = (await repo.getTenant("t1"))!;
    expect(t.cobro?.metodo?.id).toBe("pm_nueva");
    expect(t.cobro?.intentos).toBeNull();
    expect(await cobrador.cobrarCortes()).toBe(1);
    expect(stripe.cobros[1].paymentMethodId).toBe("pm_nueva");
  });
});

describe("webhook de Stripe", () => {
  it("rechaza sin firma y con firma inválida, y lo registra con motivo; nunca lee el cuerpo", async () => {
    const { cobrador, repo } = armar();
    await expect(cobrador.procesarWebhook(JSON.stringify({ type: "payment_intent.succeeded" }), undefined, "1.2.3.4")).rejects.toBeInstanceOf(ErrorFirmaStripe);
    await expect(cobrador.procesarWebhook(JSON.stringify({ type: "payment_intent.succeeded" }), "firma-mala", "1.2.3.4")).rejects.toBeInstanceOf(ErrorFirmaStripe);
    const rechazos = bitacora.filter((l) => l.includes("stripe.webhook_rechazado"));
    expect(rechazos).toHaveLength(2);
    expect(rechazos[0]).toContain("sin cabecera stripe-signature");
    expect(rechazos[1]).toContain("No signatures found");
    expect(rechazos[1]).toContain("ip=1.2.3.4");
    expect(await repo.listPagos("t1")).toHaveLength(0);
  });

  it("payment_intent.succeeded registra el pago una sola vez aunque Stripe reenvíe", async () => {
    const { cobrador, repo, stripe } = armar();
    stripe.eventos.set("ev-pi", { id: "evt_2", tipo: "payment_intent.succeeded", objeto: { id: "pi_W", amount: 437668, amount_received: 437668, metadata: { tenantId: "t1", periodo: "mensual", meses: "1", fotoHash: "abc", fotoLeidoEn: "2026-09-15T00:00:00Z", plan: "estandar", lineasTotales: "7", corte: "2026-09-15T00:00:00Z" } } });
    expect((await cobrador.procesarWebhook("ev-pi", "firma-ok")).accion).toBe("pago_registrado");
    expect((await cobrador.procesarWebhook("ev-pi", "firma-ok")).accion).toBe("pago_ya_registrado");
    const ledger = await repo.listPagos("t1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.montoMxn).toBe(4376.68);
    expect(ledger[0]!.fotoPrecios).toEqual({ hash: "abc", leidoEn: "2026-09-15T00:00:00Z" });
    expect((await repo.getTenant("t1"))!.pagadoHasta).toBe("2026-10-15T00:00:00.000Z");
  });

  it("cobro síncrono + webhook del mismo PaymentIntent = una fila", async () => {
    const { cobrador, repo, stripe } = armar();
    await cobrador.cobrarCortes();
    stripe.eventos.set("ev-pi1", { id: "evt_3", tipo: "payment_intent.succeeded", objeto: { id: "pi_1", amount_received: 437668, metadata: { tenantId: "t1", periodo: "mensual", meses: "1" } } });
    expect((await cobrador.procesarWebhook("ev-pi1", "firma-ok")).accion).toBe("pago_ya_registrado");
    expect(await repo.listPagos("t1")).toHaveLength(1);
  });

  it("refund.created crea la fila negativa buscando el pago por referencia; payment_method.detached retira la tarjeta", async () => {
    const { cobrador, repo, stripe } = armar();
    await cobrador.cobrarCortes();
    stripe.eventos.set("ev-re", { id: "evt_4", tipo: "refund.created", objeto: { id: "re_9", payment_intent: "pi_1", amount: 437668, status: "succeeded", reason: "requested_by_customer" } });
    expect((await cobrador.procesarWebhook("ev-re", "firma-ok")).accion).toBe("reembolso_registrado");
    expect((await cobrador.procesarWebhook("ev-re", "firma-ok")).accion).toBe("reembolso_ya_registrado");
    const t = (await repo.getTenant("t1"))!;
    expect(t.pagadoHasta).toBe("2026-09-15T00:00:00.000Z");
    expect((await repo.listPagos("t1")).map((p) => p.montoMxn).sort()).toEqual([-4376.68, 4376.68]);
    stripe.eventos.set("ev-pm", { id: "evt_5", tipo: "payment_method.detached", objeto: { id: "pm_1" } });
    expect((await cobrador.procesarWebhook("ev-pm", "firma-ok")).accion).toBe("metodo_retirado");
    expect((await repo.getTenant("t1"))!.cobro?.metodo).toBeNull();
  });

  it("eventos desconocidos se ignoran sin error", async () => {
    const { cobrador, stripe } = armar();
    stripe.eventos.set("ev-x", { id: "evt_6", tipo: "customer.updated", objeto: { id: "cus_1" } });
    expect((await cobrador.procesarWebhook("ev-x", "firma-ok")).accion).toBe("ignorado");
  });
});

describe("configuración y SetupIntent", () => {
  it("crea el cliente de Stripe una vez y devuelve client_secret; modo tarjeta exige tarjeta guardada", async () => {
    const { cobrador, repo } = armar({ tenants: [tenant({ cobro: null })] });
    const r = await cobrador.crearSetupIntent("t1");
    expect(r).toEqual({ clientSecret: "seti_1_secret_cus_t1", modo: "test" });
    expect((await repo.getTenant("t1"))!.cobro?.stripeCustomerId).toBe("cus_t1");
    await expect(cobrador.configurar("t1", { modo: "tarjeta" })).rejects.toMatchObject({ status: 409 });
    const c = await cobrador.configurar("t1", { periodo: "anual", lineasContratadas: 3 });
    expect(c).toMatchObject({ modo: "transferencia", periodo: "anual", lineasContratadas: 3, stripeCustomerId: "cus_t1" });
    const cot = await cobrador.cotizar((await repo.getTenant("t1"))!);
    expect(cot?.desglose.total).toBe(Math.round((1199 + 2 * 499) * 12 * 0.75 * 1.16 * 100) / 100);
  });
});
