/**
 * Copia de columna espejo (mirror) → columna Phone en monday, la pieza
 * que decide qué se escribe. Regla cerrada el 13-oct-2026, antes de la
 * cobranza de primas de We Build:
 *
 * - Un valor → se normaliza y se copia.
 * - MÁS DE UN VALOR → estado "revisar": NO se escribe, va al CSV y una
 *   persona decide. monday no garantiza el orden de los valores de un
 *   espejo; "tomar el primero" era mandar cobranza al contacto equivocado.
 * - Sin valor → "sin_valor". Destino ya lleno → "ya_tiene" (salvo sobrescribir).
 */
export type EstadoEspejo = "copiar" | "revisar" | "sin_valor" | "ya_tiene";

export interface Clasificacion {
  estado: EstadoEspejo;
  /** E.164 con '+' cuando estado = copiar. */
  telefono: string | null;
  /** Lo que traía el espejo, ya separado, para el CSV. */
  valores: string[];
  motivo: string;
}

/** Separa el display_value del espejo en valores individuales (coma o salto de línea), sin vacíos. */
export function separarValores(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\n;]/).map((v) => v.trim()).filter((v) => v.length > 0);
}

/** Dígitos; 10 dígitos = México sin lada → +52. Null si no hay dígitos. */
export function normalizarTelefono(valor: string, ladaDefault = "52"): string | null {
  let digitos = valor.replace(/\D/g, "");
  if (!digitos) return null;
  if (digitos.length === 10) digitos = `${ladaDefault}${digitos}`;
  return `+${digitos}`;
}

export function clasificar(o: { espejo: string | null | undefined; destinoActual: string | null | undefined; sobrescribir: boolean; ladaDefault?: string }): Clasificacion {
  const valores = separarValores(o.espejo);
  const base = { valores };
  if (valores.length === 0) return { ...base, estado: "sin_valor", telefono: null, motivo: "el espejo no trae teléfono" };
  // Varios valores que normalizan al MISMO número (p. ej. "442 123 4567" y "+52 442 123 4567") cuentan como uno.
  const distintos = [...new Set(valores.map((v) => normalizarTelefono(v, o.ladaDefault)).filter((t): t is string => t !== null))];
  if (distintos.length > 1) {
    return { ...base, estado: "revisar", telefono: null, motivo: `el espejo trae ${distintos.length} teléfonos distintos; monday no garantiza el orden: decide una persona` };
  }
  const telefono = distintos[0] ?? null;
  if (!telefono) return { ...base, estado: "sin_valor", telefono: null, motivo: "el espejo no trae dígitos" };
  if (!o.sobrescribir && o.destinoActual?.trim()) return { ...base, estado: "ya_tiene", telefono, motivo: `el destino ya tiene ${o.destinoActual.trim()}` };
  return { ...base, estado: "copiar", telefono, motivo: "" };
}

/** Fila del CSV de salida; comillas dobles escapadas. */
export function filaCsv(campos: (string | number | null)[]): string {
  return campos.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",");
}
