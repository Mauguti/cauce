import type { Yo } from "./api.ts";

/**
 * Días de calendario que faltan para que termine la prueba (0 = termina
 * hoy, negativo = ya venció). Null si el tenant no tiene caducidad.
 */
export function diasRestantesPrueba(
  pruebaExpiraEn: string | null,
  ahora: Date = new Date(),
): number | null {
  if (!pruebaExpiraEn) return null;
  const hoy = new Date(ahora);
  hoy.setHours(0, 0, 0, 0);
  const fin = new Date(pruebaExpiraEn);
  fin.setHours(0, 0, 0, 0);
  return Math.round((fin.getTime() - hoy.getTime()) / 86_400_000);
}

const NOMBRE_PLAN: Record<Yo["plan"], string> = {
  prueba: "Prueba",
  base: "Base",
  extras: "Extras",
};

export function nombrePlan(plan: Yo["plan"]): string {
  return NOMBRE_PLAN[plan];
}

/**
 * Texto del badge de plan. En prueba cuenta los días; en plan pagado, el
 * nombre y las líneas incluidas. El último día dice "Termina hoy" (no
 * "quedan 0 días"); al vencer, "Prueba terminada".
 */
export function etiquetaPlan(yo: Yo, ahora: Date = new Date()): string {
  if (yo.plan !== "prueba") {
    const n = yo.limites.lineas;
    return `${nombrePlan(yo.plan)} · ${n} línea${n === 1 ? "" : "s"}`;
  }
  if (!yo.pruebaVigente) return "Prueba terminada";
  const dias = diasRestantesPrueba(yo.pruebaExpiraEn, ahora);
  if (dias === null) return "Prueba";
  if (dias <= 0) return "Termina hoy";
  return `Prueba · quedan ${dias} día${dias === 1 ? "" : "s"}`;
}
