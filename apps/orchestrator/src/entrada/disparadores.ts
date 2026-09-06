/**
 * Disparadores de entrada: un mensaje entrante puede disparar una
 * respuesta automática según una condición. Se evalúan en orden de
 * `prioridad` (menor primero); la primera que coincide gana y las demás
 * no se evalúan. No es un motor de reglas general — son cuatro
 * condiciones fijas.
 */
export type TipoDisparador =
  | "primer_contacto"
  | "palabra_clave"
  | "cualquiera"
  | "fuera_horario";

export interface Horario {
  /** Zona horaria IANA, p. ej. "America/Mexico_City". */
  tz: string;
  /** Días laborables, 0=domingo … 6=sábado. */
  dias: number[];
  /** Inicio del horario laboral, "HH:MM" 24h. */
  desde: string;
  /** Fin del horario laboral, "HH:MM" 24h. */
  hasta: string;
}

export interface DisparadorEntrada {
  id: string;
  /** Orden de evaluación; menor se evalúa antes. */
  prioridad: number;
  tipo: TipoDisparador;
  activo: boolean;
  /** Texto de la respuesta automática que se envía si coincide. */
  respuesta: string;
  /** Solo palabra_clave: texto a buscar. */
  patron?: string;
  /** Solo palabra_clave: cómo comparar (default "contiene"). */
  coincidencia?: "contiene" | "igual";
  /** Solo fuera_horario: define el horario laboral; coincide fuera de él. */
  horario?: Horario;
}

export interface ContextoEntrada {
  /** Texto del mensaje entrante. */
  texto: string;
  /** ¿Es el primer mensaje que este número escribe a esta instancia? */
  esPrimerContacto: boolean;
  /** Momento del mensaje. */
  ahora: Date;
}

function normaliza(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Minutos desde medianoche de "HH:MM". */
function minutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * ¿`ahora` cae DENTRO del horario laboral? Usa Intl con la tz del
 * horario (sin librerías): día de la semana y hora local del tenant.
 */
export function dentroDeHorario(horario: Horario, ahora: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: horario.tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const partes = fmt.formatToParts(ahora);
  const dia = partes.find((p) => p.type === "weekday")?.value ?? "";
  const hora = partes.find((p) => p.type === "hour")?.value ?? "00";
  const min = partes.find((p) => p.type === "minute")?.value ?? "00";
  const mapaDias: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const numDia = mapaDias[dia];
  if (numDia === undefined || !horario.dias.includes(numDia)) return false;
  // "24" a medianoche en algunos locales: normaliza a 0.
  const ahoraMin = (Number(hora) % 24) * 60 + Number(min);
  return ahoraMin >= minutos(horario.desde) && ahoraMin < minutos(horario.hasta);
}

/** ¿Coincide este disparador con el contexto? */
export function coincide(
  d: DisparadorEntrada,
  ctx: ContextoEntrada,
): boolean {
  if (!d.activo) return false;
  switch (d.tipo) {
    case "cualquiera":
      return true;
    case "primer_contacto":
      return ctx.esPrimerContacto;
    case "palabra_clave": {
      if (!d.patron) return false;
      const texto = normaliza(ctx.texto);
      const patron = normaliza(d.patron);
      return d.coincidencia === "igual"
        ? texto === patron
        : texto.includes(patron);
    }
    case "fuera_horario":
      return d.horario ? !dentroDeHorario(d.horario, ctx.ahora) : false;
  }
}

/**
 * Devuelve el primer disparador que coincide, evaluando por prioridad
 * ascendente. null si ninguno.
 */
export function primeroQueCoincide(
  disparadores: DisparadorEntrada[],
  ctx: ContextoEntrada,
): DisparadorEntrada | null {
  const ordenados = [...disparadores].sort((a, b) => a.prioridad - b.prioridad);
  for (const d of ordenados) {
    if (coincide(d, ctx)) return d;
  }
  return null;
}
