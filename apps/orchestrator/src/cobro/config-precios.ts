import { registrar } from "../log.ts";
import type { FotoPrecios, PeriodoCobro } from "@cauce/core";

/**
 * Mapa de Stripe Price IDs por plan y periodicidad. Mau los llena desde
 * el panel de Stripe (Products → cada precio → copiar el ID `price_...`).
 *
 * NOTA DE DISEÑO: el cobro está configurado como precio unitario por
 * cantidad = 1. El monto del semestral es el equivalente mensual × 6 y
 * el del anual es el mensual × 12, con los descuentos ya aplicados.
 * No es el patrón habitual (normalmente la cantidad representa el número
 * de líneas); déjese anotado para que nadie lo malinterprete.
 *
 * Variables de entorno (todas opcionales; sin ellas Checkout no funciona):
 *   STRIPE_PRICE_BASICO_MENSUAL, STRIPE_PRICE_BASICO_SEMESTRAL, STRIPE_PRICE_BASICO_ANUAL
 *   STRIPE_PRICE_ESTANDAR_MENSUAL, STRIPE_PRICE_ESTANDAR_SEMESTRAL, STRIPE_PRICE_ESTANDAR_ANUAL
 *   STRIPE_PRICE_PRO_MENSUAL, STRIPE_PRICE_PRO_SEMESTRAL, STRIPE_PRICE_PRO_ANUAL
 */

export type PlanCobrable = "basico" | "estandar" | "pro";

export interface ConfigPrecios {
  /** price_… de Stripe por plan y periodo. Null = no configurado. */
  precios: Record<PlanCobrable, Record<PeriodoCobro, string | null>>;
  /** Todos los IDs están rellenos. */
  completa: boolean;
}

/** Montos esperados (MXN con IVA) para validación al arranque. */
const MONTOS_ESPERADOS: Record<PlanCobrable, Record<PeriodoCobro, number>> = {
  basico:   { mensual:   599, semestral:  3_234, anual:  5_388 },
  estandar: { mensual: 1_199, semestral:  6_474, anual: 10_788 },
  pro:      { mensual: 2_200, semestral: 11_880, anual: 19_800 },
};

/** Carga los 9 price IDs desde variables de entorno. */
export function cargarConfigPrecios(env: Record<string, string | undefined> = process.env): ConfigPrecios {
  const planes: PlanCobrable[] = ["basico", "estandar", "pro"];
  const periodos: PeriodoCobro[] = ["mensual", "semestral", "anual"];
  const precios = {} as ConfigPrecios["precios"];
  let faltantes = 0;
  for (const plan of planes) {
    precios[plan] = {} as Record<PeriodoCobro, string | null>;
    for (const periodo of periodos) {
      const clave = `STRIPE_PRICE_${plan.toUpperCase()}_${periodo.toUpperCase()}`;
      const valor = env[clave]?.trim() || null;
      precios[plan][periodo] = valor;
      if (!valor) faltantes++;
    }
  }
  const completa = faltantes === 0;
  if (!completa) {
    registrar("config.precios_stripe_incompleta", { faltantes, nota: "Checkout no funcionará hasta que se llenen los 9 price IDs" }, "warn");
  }
  return { precios, completa };
}

/** Obtiene el price ID para un plan y periodo; null si no está configurado. */
export function obtenerPriceId(config: ConfigPrecios, plan: PlanCobrable, periodo: PeriodoCobro): string | null {
  return config.precios[plan]?.[periodo] ?? null;
}

/**
 * Valida los montos de Stripe contra la tabla de precios esperada.
 * Recibe la foto de precios (precios.json) y los montos que reporta Stripe
 * para cada price ID. Devuelve una lista de discrepancias.
 *
 * No corrige nada: solo avisa. Mau decide.
 */
export interface DiscrepanciaPrecio {
  plan: PlanCobrable;
  periodo: PeriodoCobro;
  priceId: string;
  esperadoCentavos: number;
  reportadoCentavos: number;
}

export function validarPreciosContraTabla(
  config: ConfigPrecios,
  /** Montos en centavos que Stripe reporta para cada price ID. */
  montosStripe: Map<string, number>,
  foto: FotoPrecios,
): DiscrepanciaPrecio[] {
  const planes: PlanCobrable[] = ["basico", "estandar", "pro"];
  const periodos: PeriodoCobro[] = ["mensual", "semestral", "anual"];
  const discrepancias: DiscrepanciaPrecio[] = [];

  for (const plan of planes) {
    for (const periodo of periodos) {
      const priceId = config.precios[plan]?.[periodo];
      if (!priceId) continue;
      const reportado = montosStripe.get(priceId);
      if (reportado === undefined) continue;

      // El monto esperado en centavos (MXN) sale de la tabla fija.
      // Se contrasta contra la tabla publicada, no contra calcularCobro,
      // porque estos precios incluyen IVA y descuento ya aplicados.
      const esperado = MONTOS_ESPERADOS[plan][periodo];
      const esperadoCentavos = Math.round(esperado * 100);

      if (reportado !== esperadoCentavos) {
        discrepancias.push({ plan, periodo, priceId, esperadoCentavos, reportadoCentavos: reportado });
      }
    }
  }

  if (discrepancias.length > 0) {
    for (const d of discrepancias) {
      registrar("config.precio_discrepante", {
        plan: d.plan,
        periodo: d.periodo,
        priceId: d.priceId,
        esperado: `$${(d.esperadoCentavos / 100).toLocaleString("es-MX")} MXN`,
        reportado: `$${(d.reportadoCentavos / 100).toLocaleString("es-MX")} MXN`,
      }, "error");
    }
  }

  return discrepancias;
}
