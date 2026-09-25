import type { FotoPrecios, RegistroConsumo, Tenant, TenantId } from "@cauce/core";
import type { Repositorio } from "../store.ts";
import { registrar, registrarCadaMs } from "../log.ts";

/**
 * Medidor de energía: bolsa mensual por agente + créditos comprados.
 *
 * Orden de consumo: bolsa → créditos. Créditos no expiran.
 * Multiplicador configurable (default 1.0): convierte pesos comprados en
 * pesos de energía (p. ej. 1.2 = compras $1,000, tienes $1,200 de energía).
 *
 * Umbral de aviso: 80 % de la bolsa. Se avisa UNA vez por mes.
 * Agotada: la bolsa Y los créditos se acabaron.
 */

export const ENERGIA_MULTIPLICADOR_DEFAULT = 1.0;
export const UMBRAL_AVISO = 0.80;

export interface EstadoEnergia {
  /** Bolsa total del mes en MXN ($200 × agentes contratados). */
  bolsaTotal: number;
  /** Gasto del mes en MXN (de la tabla de consumo). */
  gastoMes: number;
  /** Lo que la bolsa cubrió (min(gastoMes, bolsaTotal)). */
  bolsaUsada: number;
  /** Lo que queda de la bolsa este mes. */
  bolsaRestante: number;
  /** Créditos comprados (MXN × multiplicador). */
  creditosDisponibles: number;
  /** Exceso que salió de créditos este mes (max(0, gastoMes - bolsaTotal)). */
  excesoCreditos: number;
  /** Créditos restantes después del exceso del mes. */
  creditosRestantes: number;
  /** Energía total disponible (bolsaRestante + creditosRestantes). */
  disponible: number;
  /** Fracción de la bolsa usada (0–1+). */
  porcentajeBolsa: number;
  /** ¿Se agotó toda la energía? */
  agotada: boolean;
}

/**
 * Calcula la bolsa mensual total del tenant en MXN.
 * Cada agente contratado trae `bolsaApiMensual` pesos (default $200).
 */
export function calcularBolsa(precios: FotoPrecios, agentesContratados: number): number {
  return precios.AGENTE.bolsaApiMensual * Math.max(1, agentesContratados);
}

/**
 * Suma el gasto del mes en MXN a partir del ledger de consumo.
 */
export function gastoMesMxn(
  consumos: RegistroConsumo[],
  tipoCambio: { usdMxn: number; colchon: number },
): number {
  const efectivo = tipoCambio.usdMxn * tipoCambio.colchon;
  const total = consumos.reduce((s, c) => s + (c.costoUsd ?? 0), 0);
  return Math.round(total * efectivo * 100) / 100;
}

/**
 * Estado completo de energía del tenant.
 */
export function estadoEnergia(
  bolsaTotal: number,
  creditosMxnRaw: number,
  gastoMes: number,
  multiplicador: number = ENERGIA_MULTIPLICADOR_DEFAULT,
): EstadoEnergia {
  const creditosDisponibles = Math.max(0, creditosMxnRaw) * multiplicador;
  const bolsaUsada = Math.min(gastoMes, bolsaTotal);
  const bolsaRestante = Math.max(0, bolsaTotal - gastoMes);
  const excesoCreditos = Math.max(0, gastoMes - bolsaTotal);
  const creditosRestantes = Math.max(0, creditosDisponibles - excesoCreditos);
  const disponible = bolsaRestante + creditosRestantes;
  const porcentajeBolsa = bolsaTotal > 0 ? bolsaUsada / bolsaTotal : 0;
  const agotada = disponible <= 0;
  return {
    bolsaTotal,
    gastoMes,
    bolsaUsada,
    bolsaRestante,
    creditosDisponibles,
    excesoCreditos,
    creditosRestantes,
    disponible,
    porcentajeBolsa,
    agotada,
  };
}

/**
 * Obtiene el estado de energía completo del tenant para el mes en curso.
 * Necesita el repositorio para leer consumo y la foto de precios para la bolsa.
 */
export async function obtenerEstadoEnergia(
  repo: Repositorio,
  tenant: Tenant,
  precios: FotoPrecios,
  tipoCambio: { usdMxn: number; colchon: number },
  ahora: Date = new Date(),
): Promise<EstadoEnergia> {
  const mes = ahora.toISOString().slice(0, 7);
  const agentesContratados = tenant.cobro?.agentesContratados ?? 1;
  const bolsa = calcularBolsa(precios, agentesContratados);
  const consumos = await repo.listConsumo(tenant.id, mes);
  const gasto = gastoMesMxn(consumos, tipoCambio);
  return estadoEnergia(bolsa, tenant.creditosMxn ?? 0, gasto);
}

/**
 * Descuenta créditos del tenant (atómico en el repo). Solo descuenta
 * el exceso que la bolsa no cubrió. Se llama después de cada respuesta
 * del agente.
 *
 * Devuelve los créditos restantes. No lanza si no hay créditos.
 */
export async function descontarCreditos(
  repo: Repositorio,
  tenantId: TenantId,
  costoMxn: number,
  bolsaRestanteAntes: number,
): Promise<number> {
  // Solo hay descuento de créditos si el costo supera lo que quedaba de bolsa.
  const excceso = Math.max(0, costoMxn - bolsaRestanteAntes);
  if (excceso <= 0) return -1; // no se tocan créditos
  const tenant = await repo.getTenant(tenantId);
  if (!tenant) return 0;
  const actual = tenant.creditosMxn ?? 0;
  const nuevo = Math.max(0, Math.round((actual - excceso) * 100) / 100);
  await repo.saveTenant({ ...tenant, creditosMxn: nuevo });
  registrar("energia.creditos_descontados", {
    tenant: tenantId,
    exceso: excceso,
    antes: actual,
    despues: nuevo,
  });
  return nuevo;
}

/**
 * Respuesta de degradación cuando la energía se agotó.
 * Si el plan incluye bots, devuelve null (el motor usará disparadores).
 * Si no, devuelve un texto de traspaso honesto.
 */
export const MENSAJE_ENERGIA_AGOTADA =
  "En este momento no puedo atenderte por este medio. " +
  "Un miembro del equipo te contactará en breve por este mismo chat. " +
  "Gracias por tu paciencia.";

/**
 * Evalúa si hay que avisar al 80 % de la bolsa. El aviso se emite
 * UNA vez por mes (el throttle de `registrarCadaMs` lo garantiza).
 */
export function evaluarAviso(
  estado: EstadoEnergia,
  tenantId: TenantId,
  avisosWhatsApp: string | null,
  enviar?: (telefono: string, cuerpo: string) => Promise<unknown>,
): void {
  if (estado.porcentajeBolsa < UMBRAL_AVISO) return;
  // Throttle: solo una vez cada 12 horas (el primer disparo del mes basta).
  registrarCadaMs(
    `energia-aviso:${tenantId}`,
    12 * 3_600_000,
    "energia.aviso_80",
    {
      tenant: tenantId,
      porcentaje: Math.round(estado.porcentajeBolsa * 100),
      bolsaUsada: estado.bolsaUsada,
      bolsaTotal: estado.bolsaTotal,
      creditosRestantes: estado.creditosRestantes,
      agotada: estado.agotada,
    },
    estado.agotada ? "error" : "warn",
  );
  if (avisosWhatsApp && enviar && estado.porcentajeBolsa >= UMBRAL_AVISO) {
    const porcentaje = Math.round(estado.porcentajeBolsa * 100);
    const msg = estado.agotada
      ? `⚡ Digsol Factory · energía agotada\nTenant ${tenantId}: la bolsa de $${estado.bolsaTotal} MXN y los créditos se agotaron. Los agentes de IA están degradados a bots.`
      : `⚡ Digsol Factory · energía al ${porcentaje}%\nTenant ${tenantId}: se ha usado el ${porcentaje}% de la bolsa mensual ($${estado.bolsaUsada} de $${estado.bolsaTotal} MXN).${estado.creditosRestantes > 0 ? ` Créditos restantes: $${estado.creditosRestantes} MXN.` : " Sin créditos comprados."}`;
    enviar(avisosWhatsApp, msg).catch(() => {});
  }
}
