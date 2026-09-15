import Stripe from "stripe";

/**
 * Frontera con Stripe. El Cobrador habla con esta interfaz; en pruebas se
 * usa una implementación en memoria (cobrador.test.ts) y en producción el
 * SDK oficial con la llave RESTRINGIDA de /etc/factory.env. Los precios
 * nunca pasan por aquí: llegan como centavos ya calculados.
 */

export interface MetodoPago {
  id: string;
  marca: string;
  ultimos4: string;
  /** "YYYY-MM" */
  vence: string;
}

export interface ResultadoCobro {
  id: string;
  estado: "succeeded" | "requires_action" | "processing" | "failed";
  codigoError: string | null;
  mensajeError: string | null;
  clientSecret: string | null;
}

export interface EventoStripe {
  id: string;
  tipo: string;
  /** El objeto del evento (setup_intent, payment_intent, charge, payment_method…), tal cual. */
  objeto: any;
}

export interface ClienteStripe {
  readonly modo: "test" | "live";
  /** Busca por metadata.tenantId; crea si no existe. Nunca dos por tenant. */
  asegurarCliente(tenantId: string, nombre: string): Promise<string>;
  crearSetupIntent(customerId: string, tenantId: string): Promise<{ id: string; clientSecret: string }>;
  metodoDePago(paymentMethodId: string): Promise<MetodoPago>;
  fijarMetodoPorDefecto(customerId: string, paymentMethodId: string): Promise<void>;
  cobrar(o: {
    customerId: string;
    paymentMethodId: string;
    centavos: number;
    descripcion: string;
    idempotencia: string;
    metadata: Record<string, string>;
  }): Promise<ResultadoCobro>;
  /** Verifica la firma y devuelve el evento; lanza si la firma no es válida. */
  construirEvento(cuerpoCrudo: Buffer | string, firma: string): EventoStripe;
}

export class ClienteStripeReal implements ClienteStripe {
  readonly #stripe: Stripe;
  readonly #webhookSecret: string;
  readonly modo: "test" | "live";

  constructor(opciones: { secretKey: string; webhookSecret: string }) {
    this.#stripe = new Stripe(opciones.secretKey, { timeout: 20_000, maxNetworkRetries: 2 });
    this.#webhookSecret = opciones.webhookSecret;
    this.modo = opciones.secretKey.startsWith("sk_live_") ? "live" : "test";
  }

  async asegurarCliente(tenantId: string, nombre: string): Promise<string> {
    const existentes = await this.#stripe.customers.search({ query: `metadata['tenantId']:'${tenantId}'`, limit: 1 });
    const previo = existentes.data[0];
    if (previo) return previo.id;
    const c = await this.#stripe.customers.create({ name: nombre, metadata: { tenantId } }, { idempotencyKey: `customer:${tenantId}` });
    return c.id;
  }

  async crearSetupIntent(customerId: string, tenantId: string): Promise<{ id: string; clientSecret: string }> {
    const si = await this.#stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: { tenantId },
    });
    if (!si.client_secret) throw new Error("Stripe no devolvió client_secret del SetupIntent");
    return { id: si.id, clientSecret: si.client_secret };
  }

  async metodoDePago(paymentMethodId: string): Promise<MetodoPago> {
    const pm = await this.#stripe.paymentMethods.retrieve(paymentMethodId);
    const card = pm.card;
    return {
      id: pm.id,
      marca: card?.brand ?? "tarjeta",
      ultimos4: card?.last4 ?? "????",
      vence: card ? `${card.exp_year}-${String(card.exp_month).padStart(2, "0")}` : "",
    };
  }

  async fijarMetodoPorDefecto(customerId: string, paymentMethodId: string): Promise<void> {
    await this.#stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  }

  async cobrar(o: { customerId: string; paymentMethodId: string; centavos: number; descripcion: string; idempotencia: string; metadata: Record<string, string> }): Promise<ResultadoCobro> {
    try {
      const pi = await this.#stripe.paymentIntents.create(
        {
          amount: o.centavos,
          currency: "mxn",
          customer: o.customerId,
          payment_method: o.paymentMethodId,
          off_session: true,
          confirm: true,
          description: o.descripcion,
          metadata: o.metadata,
        },
        { idempotencyKey: o.idempotencia },
      );
      return interpretarPI(pi);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError || err instanceof Stripe.errors.StripeInvalidRequestError) {
        const pi = (err as any).payment_intent as Stripe.PaymentIntent | undefined;
        return {
          id: pi?.id ?? "",
          estado: pi?.status === "requires_action" ? "requires_action" : "failed",
          codigoError: (err as any).code ?? (err as any).decline_code ?? err.type,
          mensajeError: err.message,
          clientSecret: pi?.client_secret ?? null,
        };
      }
      throw err;
    }
  }

  construirEvento(cuerpoCrudo: Buffer | string, firma: string): EventoStripe {
    const ev = this.#stripe.webhooks.constructEvent(cuerpoCrudo, firma, this.#webhookSecret);
    return { id: ev.id, tipo: ev.type, objeto: (ev.data as any).object };
  }
}

function interpretarPI(pi: Stripe.PaymentIntent): ResultadoCobro {
  const estado: ResultadoCobro["estado"] =
    pi.status === "succeeded" ? "succeeded" : pi.status === "requires_action" ? "requires_action" : pi.status === "processing" ? "processing" : "failed";
  return {
    id: pi.id,
    estado,
    codigoError: pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? null,
    mensajeError: pi.last_payment_error?.message ?? null,
    clientSecret: pi.client_secret ?? null,
  };
}
