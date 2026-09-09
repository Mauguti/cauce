/**
 * Bitácora de operación del orquestador.
 *
 * Una línea por evento, en formato clave=valor (logfmt), a stdout/stderr
 * → journald. Cada operación deja rastro con tenant, instancia y
 * resultado, para poder responder "no me llegan los mensajes" leyendo el
 * servidor, y para observar días de comportamiento de una sesión (no solo
 * el minuto de la conexión).
 *
 * Forma:  <ISO> <nivel> <evento> clave=valor clave="valor con espacios"
 * Ejemplo: 2026-09-09T19:03:01.123Z info instancia.crear tenant=9e718a68 instancia=f77d6518 resultado=ok ms=15342
 *
 * Reglas:
 * - Solo escribe; nunca cambia el comportamiento de lo que registra.
 * - Los teléfonos van enmascarados (últimos 4 dígitos): son datos de
 *   clientes de clientes.
 * - `registrarCadaMs` acota eventos que se repiten por sondeo (p. ej. el
 *   QR pedido cada 3 s) para no inundar el log.
 */

export type Nivel = "info" | "warn" | "error";
export type Campos = Record<string, unknown>;

/** `+5214428575347` → `+52••••5347`. Sin dígitos suficientes, `••••`. */
export function enmascararTelefono(telefono: string | null | undefined): string {
  if (!telefono) return "••••";
  const digitos = telefono.replace(/[^\d]/g, "");
  if (digitos.length <= 4) return "••••";
  const prefijo = digitos.length > 10 ? digitos.slice(0, digitos.length - 10) : "";
  return `${telefono.trim().startsWith("+") ? "+" : ""}${prefijo}••••${digitos.slice(-4)}`;
}

function valor(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Error) return citar(v.message);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return citar(v);
  return citar(JSON.stringify(v));
}

function citar(s: string): string {
  const limpio = s.replace(/[\r\n]+/g, " ");
  return /[\s="]/.test(limpio) || limpio === ""
    ? `"${limpio.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : limpio;
}

/** Pura: arma la línea. Probada aparte de la salida. */
export function formatear(
  nivel: Nivel,
  evento: string,
  campos: Campos = {},
  fecha: Date = new Date(),
): string {
  const partes = [fecha.toISOString(), nivel, evento];
  for (const [k, v] of Object.entries(campos)) {
    const s = valor(v);
    if (s !== null) partes.push(`${k}=${s}`);
  }
  return partes.join(" ");
}

let salida: (nivel: Nivel, linea: string) => void = (nivel, linea) => {
  if (nivel === "info") console.log(linea);
  else console.warn(linea);
};

/** Para pruebas: captura las líneas en vez de imprimirlas. */
export function usarSalida(fn: typeof salida | null): void {
  salida = fn ?? ((nivel, linea) => (nivel === "info" ? console.log(linea) : console.warn(linea)));
}

export function registrar(evento: string, campos: Campos = {}, nivel: Nivel = "info"): void {
  salida(nivel, formatear(nivel, evento, campos));
}

/** Nivel error con el mensaje del fallo en `error=`. */
export function registrarError(evento: string, err: unknown, campos: Campos = {}): void {
  const mensaje = err instanceof Error ? err.message : String(err);
  registrar(evento, { ...campos, error: mensaje }, "error");
}

const ultimaVez = new Map<string, number>();

/**
 * Registra a lo sumo una vez cada `ms` por `clave`. Devuelve true si se
 * registró. Para eventos que llegan por sondeo y no aportan repetidos.
 */
export function registrarCadaMs(
  clave: string,
  ms: number,
  evento: string,
  campos: Campos = {},
  nivel: Nivel = "info",
  ahora: number = Date.now(),
): boolean {
  const previa = ultimaVez.get(clave);
  if (previa !== undefined && ahora - previa < ms) return false;
  ultimaVez.set(clave, ahora);
  registrar(evento, campos, nivel);
  return true;
}

/** `const fin = cronometro(); ... fin()` → milisegundos transcurridos. */
export function cronometro(): () => number {
  const inicio = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - inicio) / 1_000_000n);
}
