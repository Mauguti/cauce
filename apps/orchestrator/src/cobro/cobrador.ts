import {
  calcularCobro,
  sumarMeses,
  type CobroConfig,
  type DesgloseCobro,
  type Pago,
  type PeriodoCobro,
  type Tenant,
  type TenantId,
} from "@cauce/core";
import type { Repositorio } from "../store.ts";
import { registrar, registrarError } from "../log.ts";
import type { CargadorPrecios, FotoLeida } from "./precios.ts";
import type { ClienteStripe, EventoStripe } from "./stripe.ts";
import type { ConfigPrecios, PlanCobrable } from "./config-precios.ts";
import { ANALITICA_APAGADA, clientIdDeCookie, type Analitica } from "../analitica/ga4.ts";
import { obtenerPriceId } from "./config-precios.ts";

/** Meses por periodo: definición del producto, no un precio. */
export const MESES_PERIODO: Record<PeriodoCobro, number> = { mensual: 1, semestral: 6, anual: 12 };

/**
 * Días de gracia antes de que un impago lleve a suspensión. UNA sola
 * constante para todos los caminos (Decisión 2 del sprint). Antes era 10;
 * como ningún cliente ha sido cobrado aún, no hay promesa previa que romper.
 */
export const GRACIA_DIAS = 5;

/**
 * Bandera de suspensión automática (Decisión 3 del sprint). APAGADA por
 * defecto: el webhook registra todo en bitácora y avisa, pero NO cambia el
 * estado del tenant. Con Procesa, GeoSpectral y We Build operando, eso no
 * se enciende el día de la fusión.
 *
 * Para encender: variable de entorno SUSPENSION_AUTOMATICA=true, o pasar
 * `true` en las opciones del Cobrador.
 */
export const SUSPENSION_AUTOMATICA = (process.env.SUSPENSION_AUTOMATICA ?? "").toLowerCase() === "true";

/** Calendario de reintentos en días desde el corte: 0, +3, +7; después, agotado.
 * @deprecated Obsoleto con Subscriptions: Stripe maneja los reintentos. Se conserva
 * para tenants que todavía usen cobrarCortes() con PaymentIntent directo. */
export const REINTENTOS_DIAS = [0, 3, 7] as const;

export class ErrorFirmaStripe extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ErrorFirmaStripe";
  }
}

export class ErrorCobro extends Error {
  readonly status: number;
  constructor(status: number, mensaje: string) {
    super(mensaje);
    this.name = "ErrorCobro";
    this.status = status;
  }
}

export interface DatosPago {
  fuente: Pago["fuente"];
  tipo: Pago["tipo"];
  referencia: string;
  /** MXN con IVA; positivo siempre: el signo lo pone `tipo`. */
  montoMxn: number;
  periodo: PeriodoCobro | null;
  /** Meses que cubre (pago) o que recorta (reembolso); positivo siempre. */
  meses: number;
  registradoPor: string;
  fotoPrecios?: Pago["fotoPrecios"];
  detalle?: Record<string, unknown>;
}

/**
 * Cobro por tarjeta (Stripe) y ledger de pagos. Reglas de docs/stripe.md:
 * - Nadie escribe `pagadoHasta` fuera de `registrarPago`; ledger append-only
 *   e idempotente por (fuente, referencia). Un reembolso es una fila
 *   negativa que recorta `pagadoHasta` los meses que devuelve.
 * - Los precios vienen de la foto de la plataforma; sin foto no se cobra.
 * - Un corte se cobra con clave de idempotencia `tenant:cicloCorteEn`.
 * - El webhook solo se cree con firma válida; el rechazo se registra.
 * - La suspensión sigue siendo a mano: aquí solo se avisa.
 */
export class Cobrador {
  readonly #repo: Repositorio;
  readonly #stripe: ClienteStripe | null;
  readonly #precios: CargadorPrecios;
  readonly #configPrecios: ConfigPrecios | null;
  readonly #avisar: ((tenantId: TenantId, texto: string) => Promise<unknown>) | null;
  readonly #ahora: () => number;
  readonly #suspensionAutomatica: boolean;

  constructor(opciones: {
    repo: Repositorio;
    stripe?: ClienteStripe | null;
    precios: CargadorPrecios;
    /** Configuración de price IDs de Stripe para Checkout. */
    configPrecios?: ConfigPrecios | null;
    /** Aviso por WhatsApp a Mau (CAUCE_AVISOS_WHATSAPP); sin él, solo bitácora. */
    avisar?: (tenantId: TenantId, texto: string) => Promise<unknown>;
    ahora?: () => number;
    /** Override para la bandera SUSPENSION_AUTOMATICA. */
    suspensionAutomatica?: boolean;
    /** Conversiones a GA4 (Protocolo de Medición). Ausente = apagada. */
    analitica?: Analitica;
  }) {
    this.#analitica = opciones.analitica ?? ANALITICA_APAGADA;
    this.#repo = opciones.repo;
    this.#stripe = opciones.stripe ?? null;
    this.#precios = opciones.precios;
    this.#configPrecios = opciones.configPrecios ?? null;
    this.#avisar = opciones.avisar ?? null;
    this.#ahora = opciones.ahora ?? (() => Date.now());
    this.#suspensionAutomatica = opciones.suspensionAutomatica ?? SUSPENSION_AUTOMATICA;
  }
  readonly #analitica: Analitica;

  get stripeModo(): "test" | "live" | null {
    return this.#stripe?.modo ?? null;
  }

  /** Foto de precios vigente (para el medidor de energía). */
  async precios(): Promise<FotoLeida | null> {
    return this.#precios.obtener();
  }

  // ── Ledger ────────────────────────────────────────────────────────────────

  /**
   * ÚNICO camino que mueve `pagadoHasta`. Pago: si lo anterior sigue vigente,
   * suma desde ahí (renovación); si ya venció, desde hoy (regularización).
   * Reembolso: resta los meses devueltos a `pagadoHasta`; si queda en el
   * pasado, el tenant pasa a vencido por la regla que ya existe.
   */
  async registrarPago(tenantId: TenantId, d: DatosPago): Promise<{ pago: Pago; nuevo: boolean }> {
    const id = `${d.fuente}-${d.referencia.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    const previo = await this.#repo.getPago(tenantId, id);
    if (previo) return { pago: previo, nuevo: false };
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) throw new ErrorCobro(404, `tenant ${tenantId} no existe`);
    if (!(d.montoMxn > 0) || !(d.meses > 0)) throw new ErrorCobro(400, "monto y meses deben ser positivos");
    const ahoraIso = new Date(this.#ahora()).toISOString();
    const antes = tenant.pagadoHasta ?? null;
    const signo = d.tipo === "reembolso" ? -1 : 1;
    // Pago: renovación (suma desde pagadoHasta) si sigue vigente o venció
    // dentro de la gracia; regularización (desde hoy) si lleva más tiempo
    // vencido. Así el corte cobrado el mismo día no pierde horas ni regala
    // días a quien paga tarde dentro de la gracia.
    const limiteGracia = new Date(this.#ahora() - GRACIA_DIAS * 86_400_000).toISOString();
    const base = d.tipo === "reembolso" ? (antes ?? ahoraIso) : antes && antes > limiteGracia ? antes : ahoraIso;
    const despues = sumarMeses(base, signo * d.meses);
    const pago: Pago = {
      id,
      tenantId,
      fuente: d.fuente,
      tipo: d.tipo,
      referencia: d.referencia,
      montoMxn: signo * Math.round(d.montoMxn * 100) / 100,
      periodo: d.periodo,
      meses: signo * d.meses,
      pagadoHastaAntes: antes,
      pagadoHastaDespues: despues,
      registradoPor: d.registradoPor,
      fotoPrecios: d.fotoPrecios ?? null,
      cfdi: { estado: "pendiente" },
      ...(d.detalle ? { detalle: d.detalle } : {}),
      en: ahoraIso,
    };
    const nuevo = await this.#repo.guardarPago(pago, { pagadoHasta: despues, cicloCorteEn: despues });
    if (!nuevo) return { pago: (await this.#repo.getPago(tenantId, id)) ?? pago, nuevo: false };
    if (d.tipo === "pago" && tenant.cobro?.intentos) {
      // El corte quedó cubierto: se limpia el estado de reintentos.
      const t = await this.#repo.getTenant(tenantId);
      if (t?.cobro) await this.#repo.saveTenant({ ...t, cobro: { ...t.cobro, intentos: null, actualizadoEn: ahoraIso } });
    }
    registrar("pago.registrado", { tenant: tenantId, fuente: d.fuente, tipo: d.tipo, referencia: d.referencia, montoMxn: pago.montoMxn, meses: pago.meses, pagadoHastaAntes: antes, pagadoHasta: despues, por: d.registradoPor });
    return { pago, nuevo: true };
  }

  async registrarTransferencia(tenantId: TenantId, d: { folio: string; montoMxn: number; periodo: PeriodoCobro; registradoPor: string }): Promise<{ pago: Pago; nuevo: boolean }> {
    const folio = d.folio.trim();
    if (!folio) throw new ErrorCobro(400, "folio requerido");
    if (!(d.periodo in MESES_PERIODO)) throw new ErrorCobro(400, "periodo debe ser mensual, semestral o anual");
    return this.registrarPago(tenantId, { fuente: "transferencia", tipo: "pago", referencia: folio, montoMxn: d.montoMxn, periodo: d.periodo, meses: MESES_PERIODO[d.periodo], registradoPor: d.registradoPor });
  }

  /**
   * Reembolso: fila negativa. Los meses que recorta salen del pago original
   * en proporción al monto (reembolso completo = todos sus meses); un
   * reembolso parcial menor a medio mes no mueve la fecha pero sí queda en
   * el ledger.
   */
  async registrarReembolso(tenantId: TenantId, d: { referencia: string; montoMxn: number; referenciaPago: string; fuente: Pago["fuente"]; registradoPor: string; detalle?: Record<string, unknown> }): Promise<{ pago: Pago; nuevo: boolean } | null> {
    const pagos = await this.#repo.listPagos(tenantId);
    const original = pagos.find((p) => p.tipo === "pago" && p.referencia === d.referenciaPago);
    if (!original) {
      registrar("pago.reembolso_sin_pago", { tenant: tenantId, referencia: d.referencia, referenciaPago: d.referenciaPago }, "warn");
      return null;
    }
    const proporcion = Math.min(1, d.montoMxn / original.montoMxn);
    const meses = Math.round(original.meses * proporcion);
    if (meses <= 0) {
      // No mueve la fecha; aun así queda la fila negativa con 0 meses.
      const id = `${d.fuente}-${d.referencia.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
      const previo = await this.#repo.getPago(tenantId, id);
      if (previo) return { pago: previo, nuevo: false };
      const tenant = await this.#repo.getTenant(tenantId);
      if (!tenant) throw new ErrorCobro(404, `tenant ${tenantId} no existe`);
      const ahoraIso = new Date(this.#ahora()).toISOString();
      const pago: Pago = { id, tenantId, fuente: d.fuente, tipo: "reembolso", referencia: d.referencia, montoMxn: -Math.round(d.montoMxn * 100) / 100, periodo: original.periodo, meses: 0, pagadoHastaAntes: tenant.pagadoHasta ?? null, pagadoHastaDespues: tenant.pagadoHasta ?? ahoraIso, registradoPor: d.registradoPor, fotoPrecios: null, cfdi: { estado: "pendiente" }, detalle: { referenciaPago: d.referenciaPago, ...(d.detalle ?? {}) }, en: ahoraIso };
      const nuevo = await this.#repo.guardarPago(pago, { pagadoHasta: tenant.pagadoHasta ?? null, cicloCorteEn: tenant.cicloCorteEn ?? null });
      registrar("pago.registrado", { tenant: tenantId, fuente: d.fuente, tipo: "reembolso", referencia: d.referencia, montoMxn: pago.montoMxn, meses: 0, pagadoHasta: pago.pagadoHastaDespues, por: d.registradoPor });
      return { pago, nuevo };
    }
    return this.registrarPago(tenantId, { fuente: d.fuente, tipo: "reembolso", referencia: d.referencia, montoMxn: d.montoMxn, periodo: original.periodo, meses, registradoPor: d.registradoPor, detalle: { referenciaPago: d.referenciaPago, ...(d.detalle ?? {}) } });
  }

  // ── Configuración y cotización ────────────────────────────────────────────

  async configurar(tenantId: TenantId, cambios: Partial<Pick<CobroConfig, "modo" | "periodo" | "lineasContratadas" | "agentesContratados">>): Promise<CobroConfig> {
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) throw new ErrorCobro(404, "tenant no encontrado");
    const previo = tenant.cobro ?? cobroDefault();
    if (cambios.modo !== undefined && cambios.modo !== "tarjeta" && cambios.modo !== "transferencia") throw new ErrorCobro(400, "modo debe ser tarjeta o transferencia");
    if (cambios.modo === "tarjeta" && !previo.metodo) throw new ErrorCobro(409, "primero guarda una tarjeta");
    if (cambios.periodo !== undefined && !(cambios.periodo in MESES_PERIODO)) throw new ErrorCobro(400, "periodo debe ser mensual, semestral o anual");
    for (const k of ["lineasContratadas", "agentesContratados"] as const) {
      const v = cambios[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 500)) throw new ErrorCobro(400, `${k} debe ser un entero entre 0 y 500`);
    }
    const cobro: CobroConfig = {
      ...previo,
      ...(cambios.modo !== undefined ? { modo: cambios.modo } : {}),
      ...(cambios.periodo !== undefined ? { periodo: cambios.periodo } : {}),
      ...(cambios.lineasContratadas !== undefined ? { lineasContratadas: Math.max(1, cambios.lineasContratadas) } : {}),
      ...(cambios.agentesContratados !== undefined ? { agentesContratados: cambios.agentesContratados } : {}),
      actualizadoEn: new Date(this.#ahora()).toISOString(),
    };
    await this.#repo.saveTenant({ ...tenant, cobro });
    registrar("cobro.configurado", { tenant: tenantId, modo: cobro.modo, periodo: cobro.periodo, lineas: cobro.lineasContratadas ?? 1, agentes: cobro.agentesContratados ?? null });
    return cobro;
  }

  /** Desglose del próximo cobro con la foto vigente; null si no hay foto o el plan no se cobra. */
  async cotizar(tenant: Tenant, foto?: FotoLeida | null): Promise<{ desglose: DesgloseCobro; foto: FotoLeida } | null> {
    const f = foto === undefined ? await this.#precios.obtener() : foto;
    if (!f) return null;
    const plan = tenant.plan;
    if (plan !== "basico" && plan !== "estandar" && plan !== "pro") return null;
    const cobro = tenant.cobro ?? cobroDefault();
    const incluidos = plan === "pro" ? f.precios.AGENTE.incluidosEnPro : 0;
    const contratados = cobro.agentesContratados ?? incluidos;
    const desglose = calcularCobro(f.precios, {
      plan,
      lineasTotales: cobro.lineasContratadas ?? 1,
      agentesAdicionales: plan === "pro" ? Math.max(0, contratados - incluidos) : 0,
      periodo: cobro.periodo,
    });
    return { desglose, foto: f };
  }

  // ── Tarjeta ───────────────────────────────────────────────────────────────

  async crearSetupIntent(tenantId: TenantId): Promise<{ clientSecret: string; modo: "test" | "live" }> {
    if (!this.#stripe) throw new ErrorCobro(503, "cobro con tarjeta no disponible: Stripe sin configurar");
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) throw new ErrorCobro(404, "tenant no encontrado");
    const cobro = tenant.cobro ?? cobroDefault();
    let customerId = cobro.stripeCustomerId ?? null;
    if (!customerId) {
      customerId = await this.#stripe.asegurarCliente(tenantId, tenant.nombre);
      await this.#repo.saveTenant({ ...tenant, cobro: { ...cobro, stripeCustomerId: customerId, actualizadoEn: new Date(this.#ahora()).toISOString() } });
      registrar("cobro.cliente_stripe", { tenant: tenantId, customer: customerId, modo: this.#stripe.modo });
    }
    const si = await this.#stripe.crearSetupIntent(customerId, tenantId);
    registrar("cobro.setup_intent", { tenant: tenantId, setupIntent: si.id, modo: this.#stripe.modo });
    return { clientSecret: si.clientSecret, modo: this.#stripe.modo };
  }

  async #guardarMetodo(tenantId: TenantId, paymentMethodId: string, customerId: string | null): Promise<void> {
    if (!this.#stripe) return;
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) {
      registrar("cobro.metodo_tenant_desconocido", { tenant: tenantId, metodo: paymentMethodId }, "warn");
      return;
    }
    const metodo = await this.#stripe.metodoDePago(paymentMethodId);
    const cobro = tenant.cobro ?? cobroDefault();
    const customer = customerId ?? cobro.stripeCustomerId ?? null;
    if (customer) await this.#stripe.fijarMetodoPorDefecto(customer, paymentMethodId);
    // Tarjeta nueva: el job vuelve a intentar el corte pendiente ese mismo día.
    await this.#repo.saveTenant({ ...tenant, cobro: { ...cobro, stripeCustomerId: customer, metodo, modo: "tarjeta", intentos: null, actualizadoEn: new Date(this.#ahora()).toISOString() } });
    registrar("cobro.metodo_guardado", { tenant: tenantId, marca: metodo.marca, ultimos4: metodo.ultimos4, vence: metodo.vence });
  }

  // ── Suscripción (Stripe Checkout + Customer Portal) ──────────────────────

  /**
   * Crea una sesión de Checkout hospedada para suscribir al tenant.
   * Stripe maneja la captura de tarjeta, el trial y el cobro recurrente.
   * 14 días de prueba con funciones del Estándar sin agentes.
   */
  async iniciarSuscripcion(tenantId: TenantId, plan: PlanCobrable, periodo: PeriodoCobro, urls: { success: string; cancel: string }, extra: { ga4ClientId?: string | null } = {}): Promise<{ url: string; modo: "test" | "live" }> {
    if (!this.#stripe) throw new ErrorCobro(503, "cobro con tarjeta no disponible: Stripe sin configurar");
    if (!this.#configPrecios?.completa) throw new ErrorCobro(503, "precios de Stripe no configurados: faltan price IDs");
    const priceId = obtenerPriceId(this.#configPrecios, plan, periodo);
    if (!priceId) throw new ErrorCobro(400, `no hay precio configurado para ${plan}/${periodo}`);
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) throw new ErrorCobro(404, "tenant no encontrado");
    const cobro = tenant.cobro ?? cobroDefault();
    let customerId = cobro.stripeCustomerId ?? null;
    if (!customerId) {
      customerId = await this.#stripe.asegurarCliente(tenantId, tenant.nombre);
      await this.#repo.saveTenant({ ...tenant, cobro: { ...cobro, stripeCustomerId: customerId, actualizadoEn: new Date(this.#ahora()).toISOString() } });
      registrar("cobro.cliente_stripe", { tenant: tenantId, customer: customerId, modo: this.#stripe.modo });
    }
    // plan y periodo van en la metadata para que invoice.paid sepa cuántos meses
    // cubre la factura; ga4ClientId solo existe ahora (cookie _ga del navegador).
    const ga4ClientId = clientIdDeCookie(extra.ga4ClientId);
    const session = await this.#stripe.crearCheckoutSession({
      customerId,
      priceId,
      tenantId,
      trialDias: 14,
      successUrl: urls.success,
      cancelUrl: urls.cancel,
      metadata: { plan, periodo, meses: String(MESES_PERIODO[periodo]), ...(ga4ClientId ? { ga4ClientId } : {}) },
    });
    registrar("cobro.checkout_creado", { tenant: tenantId, session: session.id, plan, periodo, priceId, modo: this.#stripe.modo, ga4: Boolean(ga4ClientId) });
    if (this.#analitica.activa) await this.#analitica.evento(ga4ClientId, "checkout_iniciado", { plan, periodicidad: periodo, modo: this.#stripe.modo });
    return { url: session.url, modo: this.#stripe.modo };
  }

  /** Genera un enlace al Customer Portal de Stripe para gestionar la suscripción. */
  async portalCliente(tenantId: TenantId, returnUrl: string): Promise<{ url: string }> {
    if (!this.#stripe) throw new ErrorCobro(503, "Stripe sin configurar");
    const tenant = await this.#repo.getTenant(tenantId);
    if (!tenant) throw new ErrorCobro(404, "tenant no encontrado");
    const customerId = tenant.cobro?.stripeCustomerId;
    if (!customerId) throw new ErrorCobro(409, "el tenant no tiene un cliente de Stripe asociado");
    const session = await this.#stripe.crearPortalSession(customerId, returnUrl);
    registrar("cobro.portal_creado", { tenant: tenantId, modo: this.#stripe.modo });
    return { url: session.url };
  }

  // ── Job diario ────────────────────────────────────────────────────────────

  /**
   * Cobra los cortes vencidos de los tenants con tarjeta. Idempotente; devuelve cuántos cobros intentó.
   * @deprecated Obsoleto para tenants con suscripción de Stripe. cobrarCortes() SALTA
   * tenants con stripeSubscriptionId (Stripe los cobra solo).
   */
  async cobrarCortes(): Promise<number> {
    if (!this.#stripe) return 0;
    const ahora = this.#ahora();
    const ahoraIso = new Date(ahora).toISOString();
    // Salta tenants con suscripción de Stripe (Stripe los cobra solo).
    const tenants = (await this.#repo.listTenants()).filter((t) => t.cobro?.modo === "tarjeta" && t.cobro.metodo && !t.cobro.stripeSubscriptionId && t.cicloCorteEn && t.cicloCorteEn <= ahoraIso && t.estado === "activo");
    if (tenants.length === 0) return 0;
    const foto = await this.#precios.obtener();
    if (!foto) {
      registrar("cobro.sin_precios", { pendientes: tenants.length, nota: "no se cobra sin foto de precios" }, "error");
      await this.#aviso(tenants[0]!.id, `⚠️ Digsol Factory · cobros\nNo hay foto de precios (CAUCE_PRECIOS_URL). ${tenants.length} corte(s) sin cobrar hasta que responda.`);
      return 0;
    }
    let intentados = 0;
    for (const tenant of tenants) {
      try {
        if (await this.#cobrarCorte(tenant, foto, ahora)) intentados += 1;
      } catch (err) {
        registrarError("cobro.error", err, { tenant: tenant.id, corte: tenant.cicloCorteEn ?? null });
      }
    }
    return intentados;
  }

  async #cobrarCorte(tenant: Tenant, foto: FotoLeida, ahora: number): Promise<boolean> {
    const stripe = this.#stripe!;
    const cobro = tenant.cobro!;
    const corte = tenant.cicloCorteEn!;
    const intentos = cobro.intentos?.corte === corte ? cobro.intentos : null;
    if (intentos?.agotado || intentos?.requiereAccion) return false;
    const dias = (ahora - new Date(corte).getTime()) / 86_400_000;
    const fallos = intentos?.fallos ?? 0;
    const siguiente = REINTENTOS_DIAS[fallos];
    if (siguiente === undefined || dias < siguiente) return false;
    const cot = await this.cotizar(tenant, foto);
    if (!cot) {
      registrar("cobro.no_cobrable", { tenant: tenant.id, plan: tenant.plan, corte }, "warn");
      return false;
    }
    const { desglose } = cot;
    const base = { tenant: tenant.id, corte, intento: fallos + 1, centavos: desglose.centavos, periodo: desglose.periodo, plan: desglose.plan, lineas: desglose.lineasTotales, agentesAdicionales: desglose.agentesAdicionales, foto: foto.hash };
    const r = await stripe.cobrar({
      customerId: cobro.stripeCustomerId!,
      paymentMethodId: cobro.metodo!.id,
      centavos: desglose.centavos,
      descripcion: `Digsol Factory · ${tenant.nombre} · ${desglose.plan} ${desglose.periodo} · corte ${corte.slice(0, 10)}`,
      idempotencia: `${tenant.id}:${corte}`,
      metadata: { tenantId: tenant.id, corte, periodo: desglose.periodo, meses: String(desglose.meses), fotoHash: foto.hash, fotoLeidoEn: foto.leidoEn, plan: desglose.plan, lineasTotales: String(desglose.lineasTotales), agentesAdicionales: String(desglose.agentesAdicionales) },
    });
    const ahoraIso = new Date(ahora).toISOString();
    if (r.estado === "succeeded") {
      registrar("cobro.exitoso", { ...base, paymentIntent: r.id });
      // El webhook trae lo mismo; registrarPago es idempotente por referencia.
      await this.registrarPago(tenant.id, { fuente: "stripe", tipo: "pago", referencia: r.id, montoMxn: desglose.total, periodo: desglose.periodo, meses: desglose.meses, registradoPor: "stripe:cobro", fotoPrecios: { hash: foto.hash, leidoEn: foto.leidoEn }, detalle: { desglose } });
      return true;
    }
    if (r.estado === "processing") {
      registrar("cobro.en_proceso", { ...base, paymentIntent: r.id });
      return true;
    }
    const t = (await this.#repo.getTenant(tenant.id)) ?? tenant;
    if (r.estado === "requires_action") {
      registrar("cobro.requiere_accion", { ...base, paymentIntent: r.id, codigo: r.codigoError }, "warn");
      await this.#repo.saveTenant({ ...t, cobro: { ...t.cobro!, intentos: { corte, fallos, ultimoError: r.codigoError ?? "authentication_required", ultimoIntentoEn: ahoraIso, requiereAccion: r.clientSecret, agotado: false }, actualizadoEn: ahoraIso } });
      return true;
    }
    const nuevosFallos = fallos + 1;
    const agotado = nuevosFallos >= REINTENTOS_DIAS.length;
    const metodoInvalido = r.codigoError !== null && ["expired_card", "resource_missing", "payment_method_not_available", "invalid_card"].includes(r.codigoError);
    registrar(agotado ? "cobro.agotado" : "cobro.fallido", { ...base, paymentIntent: r.id || null, codigo: r.codigoError, error: r.mensajeError, fallos: nuevosFallos }, agotado ? "error" : "warn");
    await this.#repo.saveTenant({
      ...t,
      cobro: {
        ...t.cobro!,
        ...(metodoInvalido ? { metodo: null } : {}),
        intentos: { corte, fallos: nuevosFallos, ultimoError: r.codigoError ?? r.mensajeError ?? "desconocido", ultimoIntentoEn: ahoraIso, requiereAccion: null, agotado },
        actualizadoEn: ahoraIso,
      },
    });
    if (agotado || metodoInvalido) {
      const restantes = Math.max(0, Math.ceil(GRACIA_DIAS - dias));
      await this.#aviso(tenant.id, `⚠️ Digsol Factory · cobro ${agotado ? "agotado" : "sin tarjeta válida"}\nTenant ${tenant.nombre} (${tenant.id}), corte ${corte.slice(0, 10)}, $${desglose.total.toLocaleString("es-MX")} MXN, ${desglose.periodo}.\nCódigo: ${r.codigoError ?? "desconocido"}. Gracia restante: ~${restantes} día(s). La suspensión sigue siendo a mano.`);
    }
    return true;
  }

  async #aviso(tenantId: TenantId, texto: string): Promise<void> {
    if (!this.#avisar) return;
    try {
      await this.#avisar(tenantId, texto);
    } catch (err) {
      registrarError("cobro.aviso_fallido", err, { tenant: tenantId });
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Procesa un evento de Stripe. Nada del cuerpo se lee antes de verificar la
   * firma; si no es válida, se registra `stripe.webhook_rechazado` con el
   * motivo y se lanza ErrorFirmaStripe (400). Idempotente: registrarPago
   * ignora referencias ya vistas.
   */
  async procesarWebhook(cuerpoCrudo: Buffer | string, firma: string | undefined, ip?: string): Promise<{ recibido: true; tipo: string; accion: string }> {
    if (!this.#stripe) {
      registrar("stripe.webhook_rechazado", { motivo: "Stripe sin configurar", ip: ip ?? null }, "warn");
      throw new ErrorFirmaStripe("Stripe sin configurar");
    }
    if (!firma) {
      registrar("stripe.webhook_rechazado", { motivo: "sin cabecera stripe-signature", ip: ip ?? null, bytes: cuerpoCrudo.length }, "warn");
      throw new ErrorFirmaStripe("sin firma");
    }
    let ev: EventoStripe;
    try {
      ev = this.#stripe.construirEvento(cuerpoCrudo, firma);
    } catch (err) {
      registrar("stripe.webhook_rechazado", { motivo: err instanceof Error ? err.message : String(err), ip: ip ?? null, bytes: cuerpoCrudo.length }, "warn");
      throw new ErrorFirmaStripe("firma inválida");
    }
    const o = ev.objeto ?? {};
    const tenantId: string | undefined = o.metadata?.tenantId;
    const base = { evento: ev.id, tipo: ev.tipo, tenant: tenantId ?? null };
    let accion = "ignorado";
    switch (ev.tipo) {
      case "setup_intent.succeeded": {
        if (!tenantId || typeof o.payment_method !== "string") break;
        await this.#guardarMetodo(tenantId, o.payment_method, typeof o.customer === "string" ? o.customer : null);
        accion = "metodo_guardado";
        break;
      }
      case "payment_intent.succeeded": {
        if (!tenantId) break;
        const periodo = (o.metadata?.periodo as PeriodoCobro | undefined) ?? null;
        const meses = Number(o.metadata?.meses ?? (periodo ? MESES_PERIODO[periodo] : 0));
        const montoMxn = Number(o.amount_received ?? o.amount ?? 0) / 100;
        if (!(meses > 0) || !(montoMxn > 0)) {
          registrar("stripe.webhook_incompleto", { ...base, meses, montoMxn }, "warn");
          break;
        }
        const r = await this.registrarPago(tenantId, {
          fuente: "stripe", tipo: "pago", referencia: String(o.id), montoMxn, periodo, meses, registradoPor: "stripe:webhook",
          fotoPrecios: o.metadata?.fotoHash ? { hash: String(o.metadata.fotoHash), leidoEn: String(o.metadata.fotoLeidoEn ?? "") } : null,
          detalle: { plan: o.metadata?.plan ?? null, lineasTotales: o.metadata?.lineasTotales ?? null, agentesAdicionales: o.metadata?.agentesAdicionales ?? null, corte: o.metadata?.corte ?? null },
        });
        accion = r.nuevo ? "pago_registrado" : "pago_ya_registrado";
        break;
      }
      case "payment_intent.payment_failed": {
        if (!tenantId) break;
        const codigo = o.last_payment_error?.code ?? o.last_payment_error?.decline_code ?? null;
        registrar("cobro.fallido_webhook", { ...base, paymentIntent: o.id, codigo, error: o.last_payment_error?.message ?? null }, "warn");
        accion = "fallo_registrado";
        break;
      }
      case "payment_method.detached": {
        const pmId = String(o.id ?? "");
        const tenants = (await this.#repo.listTenants()).filter((t) => t.cobro?.metodo?.id === pmId);
        for (const t of tenants) {
          await this.#repo.saveTenant({ ...t, cobro: { ...t.cobro!, metodo: null, actualizadoEn: new Date(this.#ahora()).toISOString() } });
          registrar("cobro.metodo_retirado", { ...base, tenant: t.id, metodo: pmId }, "warn");
        }
        accion = tenants.length ? "metodo_retirado" : "ignorado";
        break;
      }
      case "refund.created":
      case "refund.updated": {
        if (o.status && o.status !== "succeeded" && o.status !== "pending") break;
        const r = await this.#reembolsoStripe(o);
        accion = r;
        break;
      }
      case "charge.refunded": {
        const lista: any[] = Array.isArray(o.refunds?.data) ? o.refunds.data : [];
        let hecho = "ignorado";
        for (const re of lista) hecho = await this.#reembolsoStripe({ ...re, payment_intent: re.payment_intent ?? o.payment_intent });
        accion = hecho;
        break;
      }
      case "checkout.session.completed": {
        const tid: string | undefined = o.metadata?.tenantId ?? o.subscription_data?.metadata?.tenantId;
        if (!tid || typeof o.subscription !== "string") break;
        const t = await this.#repo.getTenant(tid);
        if (!t) { registrar("cobro.checkout_tenant_desconocido", { ...base, tenant: tid }, "warn"); break; }
        const cobro = t.cobro ?? cobroDefault();
        const customer = typeof o.customer === "string" ? o.customer : cobro.stripeCustomerId ?? null;
        await this.#repo.saveTenant({
          ...t,
          cobro: { ...cobro, stripeCustomerId: customer, stripeSubscriptionId: o.subscription, stripeSubscriptionStatus: "active", actualizadoEn: new Date(this.#ahora()).toISOString() },
        });
        registrar("cobro.suscripcion_vinculada", { tenant: tid, subscription: o.subscription, customer });
        // La prueba de 14 días arranca aquí: Checkout completado con trial, sin cargo.
        if (this.#analitica.activa) await this.#analitica.evento(o.metadata?.ga4ClientId, "prueba_iniciada", { plan: String(o.metadata?.plan ?? ""), periodicidad: String(o.metadata?.periodo ?? "") });
        accion = "suscripcion_vinculada";
        break;
      }
      case "invoice.paid": {
        const subId = typeof o.subscription === "string" ? o.subscription : null;
        const tid = o.subscription_details?.metadata?.tenantId ?? o.lines?.data?.[0]?.metadata?.tenantId ?? null;
        if (!tid || !subId) {
          // Puede ser una factura sin suscripción; se ignora.
          break;
        }
        const montoMxn = Number(o.amount_paid ?? 0) / 100;
        // La metadata de la suscripción (plan, periodo, meses, ga4ClientId) viene
        // en subscription_details.metadata; las líneas la repiten.
        const meta = { ...(o.lines?.data?.[0]?.metadata ?? {}), ...(o.subscription_details?.metadata ?? {}) } as Record<string, string | undefined>;
        const periodo = (meta.periodo && meta.periodo in MESES_PERIODO ? meta.periodo : null) as PeriodoCobro | null;
        const meses = Number(meta.meses ?? (periodo ? MESES_PERIODO[periodo] : 1));
        if (montoMxn > 0 && meses > 0) {
          const r = await this.registrarPago(tid, {
            fuente: "stripe", tipo: "pago", referencia: String(o.id), montoMxn, periodo, meses,
            registradoPor: "stripe:subscription",
          });
          accion = r.nuevo ? "pago_registrado" : "pago_ya_registrado";
          if (r.nuevo && this.#analitica.activa) await this.#analitica.evento(meta.ga4ClientId, "suscripcion_activa", { plan: String(meta.plan ?? ""), periodicidad: String(periodo ?? ""), value: montoMxn, currency: "MXN", transaction_id: String(o.id) });
        } else {
          // Factura de $0 (trial); solo sincroniza el estado.
          accion = "factura_trial";
        }
        // Sincronizar estado de suscripción.
        const t = await this.#repo.getTenant(tid);
        if (t) {
          const cobro = t.cobro ?? cobroDefault();
          await this.#repo.saveTenant({
            ...t,
            ...(t.estado === "suspendido" && this.#suspensionAutomatica ? { estado: "activo" as const } : {}),
            cobro: { ...cobro, stripeSubscriptionId: subId, stripeSubscriptionStatus: "active", intentos: null, actualizadoEn: new Date(this.#ahora()).toISOString() },
          });
          if (t.estado === "suspendido" && this.#suspensionAutomatica) {
            registrar("cobro.reactivado", { tenant: tid, subscription: subId, evento: ev.id });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const subId = typeof o.subscription === "string" ? o.subscription : null;
        const tid = o.subscription_details?.metadata?.tenantId ?? o.lines?.data?.[0]?.metadata?.tenantId ?? null;
        if (!tid || !subId) break;
        const t = await this.#repo.getTenant(tid);
        if (!t) break;
        const cobro = t.cobro ?? cobroDefault();
        // Arranca la gracia de GRACIA_DIAS días.
        const ahora = new Date(this.#ahora());
        const graciaHasta = new Date(ahora.getTime() + GRACIA_DIAS * 86_400_000).toISOString();
        await this.#repo.saveTenant({
          ...t,
          cobro: { ...cobro, stripeSubscriptionId: subId, stripeSubscriptionStatus: "past_due", actualizadoEn: ahora.toISOString() },
        });
        registrar("cobro.pago_fallido_suscripcion", { tenant: tid, subscription: subId, evento: ev.id, graciaHasta, suspensionAutomatica: this.#suspensionAutomatica }, "warn");
        await this.#aviso(tid, `⚠️ Digsol Factory · pago fallido\nTenant ${t.nombre} (${tid}), suscripción ${subId}.\nGracia hasta ${graciaHasta.slice(0, 10)}. Suspensión automática: ${this.#suspensionAutomatica ? "SÍ" : "NO (a mano)"}.`);
        accion = "pago_fallido_suscripcion";
        break;
      }
      case "customer.subscription.updated": {
        const tid: string | undefined = o.metadata?.tenantId;
        if (!tid) break;
        const t = await this.#repo.getTenant(tid);
        if (!t) break;
        const cobro = t.cobro ?? cobroDefault();
        const status = String(o.status ?? "active") as NonNullable<CobroConfig["stripeSubscriptionStatus"]>;
        await this.#repo.saveTenant({
          ...t,
          cobro: { ...cobro, stripeSubscriptionId: String(o.id), stripeSubscriptionStatus: status, actualizadoEn: new Date(this.#ahora()).toISOString() },
        });
        registrar("cobro.suscripcion_actualizada", { tenant: tid, subscription: o.id, status, evento: ev.id });
        accion = "suscripcion_actualizada";
        break;
      }
      case "customer.subscription.deleted": {
        const tid: string | undefined = o.metadata?.tenantId;
        if (!tid) break;
        const t = await this.#repo.getTenant(tid);
        if (!t) break;
        const cobro = t.cobro ?? cobroDefault();
        if (this.#suspensionAutomatica) {
          await this.#repo.saveTenant({
            ...t,
            estado: "suspendido",
            cobro: { ...cobro, stripeSubscriptionId: String(o.id), stripeSubscriptionStatus: "canceled", actualizadoEn: new Date(this.#ahora()).toISOString() },
          });
          registrar("cobro.suspendido_automatico", { tenant: tid, subscription: o.id, evento: ev.id }, "warn");
          await this.#aviso(tid, `🔴 Digsol Factory · suspensión automática\nTenant ${t.nombre} (${tid}) suspendido: suscripción ${o.id} cancelada/eliminada.`);
        } else {
          await this.#repo.saveTenant({
            ...t,
            cobro: { ...cobro, stripeSubscriptionId: String(o.id), stripeSubscriptionStatus: "canceled", actualizadoEn: new Date(this.#ahora()).toISOString() },
          });
          registrar("cobro.suscripcion_cancelada_sin_suspension", { tenant: tid, subscription: o.id, evento: ev.id, nota: "SUSPENSION_AUTOMATICA=false, no se suspende" }, "warn");
          await this.#aviso(tid, `⚠️ Digsol Factory · suscripción cancelada\nTenant ${t.nombre} (${tid}), suscripción ${o.id}. SUSPENSION_AUTOMATICA=false: el tenant sigue activo. Suspender a mano si procede.`);
        }
        accion = this.#suspensionAutomatica ? "suspendido" : "suscripcion_cancelada";
        break;
      }
      default:
        break;
    }
    registrar("stripe.webhook", { ...base, accion });
    return { recibido: true, tipo: ev.tipo, accion };
  }

  async #reembolsoStripe(re: any): Promise<string> {
    const piId = typeof re.payment_intent === "string" ? re.payment_intent : re.payment_intent?.id;
    if (!piId || !re.id) return "ignorado";
    // El reembolso no trae metadata del tenant: se busca el pago original por referencia.
    for (const t of await this.#repo.listTenants()) {
      const pagos = await this.#repo.listPagos(t.id);
      if (!pagos.some((p) => p.fuente === "stripe" && p.tipo === "pago" && p.referencia === piId)) continue;
      const r = await this.registrarReembolso(t.id, { referencia: String(re.id), montoMxn: Number(re.amount ?? 0) / 100, referenciaPago: piId, fuente: "stripe", registradoPor: "stripe:webhook", detalle: { motivo: re.reason ?? null } });
      return r ? (r.nuevo ? "reembolso_registrado" : "reembolso_ya_registrado") : "ignorado";
    }
    registrar("pago.reembolso_sin_pago", { referencia: re.id, referenciaPago: piId }, "warn");
    return "ignorado";
  }
}

export function cobroDefault(): CobroConfig {
  return { modo: "transferencia", periodo: "mensual", lineasContratadas: 1, stripeCustomerId: null, metodo: null, intentos: null, actualizadoEn: new Date(0).toISOString() };
}
