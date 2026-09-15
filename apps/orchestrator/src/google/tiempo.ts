/**
 * Fechas en la zona horaria del calendario, nunca en la del servidor.
 * Querétaro es UTC−6 sin horario de verano; Baja California cambia. Todo
 * lo que Susana lee, escribe o dice pasa por aquí con la `zona` que
 * declara el calendario de Google.
 */

const FMT = new Map<string, Intl.DateTimeFormat>();
function fmt(zona: string): Intl.DateTimeFormat {
  let f = FMT.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FMT.set(zona, f);
  }
  return f;
}

/** Partes locales de un instante en la zona. */
export function partesEn(zona: string, instante: Date): { anio: number; mes: number; dia: number; hora: number; minuto: number; segundo: number; diaSemana: number } {
  const p = Object.fromEntries(fmt(zona).formatToParts(instante).map((x) => [x.type, x.value]));
  const anio = Number(p.year), mes = Number(p.month), dia = Number(p.day);
  return { anio, mes, dia, hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second), diaSemana: new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay() };
}

/** Desfase de la zona respecto a UTC en minutos, para ese instante. */
export function desfaseMin(zona: string, instante: Date): number {
  const p = partesEn(zona, instante);
  const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return Math.round((comoUtc - instante.getTime()) / 60_000);
}

/** Instante UTC de una fecha y hora LOCALES de la zona ("2026-09-20", "10:30"). Resuelve el desfase iterando (cubre cambios de horario). */
export function instanteEn(zona: string, fecha: string, hora: string): Date {
  const [a, m, d] = fecha.split("-").map(Number);
  const [h, mi] = hora.split(":").map(Number);
  const local = Date.UTC(a!, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  let guess = new Date(local);
  for (let i = 0; i < 3; i++) {
    const off = desfaseMin(zona, guess);
    const ajustado = new Date(local - off * 60_000);
    if (ajustado.getTime() === guess.getTime()) break;
    guess = ajustado;
  }
  return guess;
}

/** "YYYY-MM-DD" local de un instante en la zona. */
export function fechaLocal(zona: string, instante: Date): string {
  const p = partesEn(zona, instante);
  return `${p.anio}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** "HH:mm" local. */
export function horaLocal(zona: string, instante: Date): string {
  const p = partesEn(zona, instante);
  return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}

/** Suma días calendario a una fecha local "YYYY-MM-DD". */
export function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a!, (m ?? 1) - 1, (d ?? 1) + dias)).toISOString().slice(0, 10);
}

/** Cómo se le dice al cliente: "sáb 20 sep, 10:30". Siempre en la zona del calendario. */
export function describir(zona: string, instante: Date): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instante).replace(",", "");
}

export function describirDia(zona: string, fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, weekday: "long", day: "numeric", month: "long" }).format(instanteEn(zona, fecha, "12:00"));
}
