/**
 * Piezas compartidas por todos los conectores de CRM (monday, Bitrix24…):
 * el modelo de plantillas salientes, su render y su selección. Cada
 * conector concreto (board de monday, entidad de Bitrix) adapta sus datos
 * a `ContextoRender` y reutiliza todo lo demás — la cola, el motor de
 * disparadores, el estado de conversación y el cifrado son la misma base.
 */

/** Id de la plantilla que responde en la URL corta (compatibilidad). */
export const PLANTILLA_DEFECTO_ID = "default";

/** Resultado del último disparo de UNA plantilla, para el listado en la UI. */
export type ResultadoPlantilla =
  | { ok: true; itemId: string; telefono: string; en: string }
  | { ok: false; error: string; en: string };

/**
 * Una plantilla de mensaje saliente. Cada una tiene su propia URL de
 * webhook (`/webhooks/<crm>/{tenant}/{id}`), así el cliente apunta
 * automatizaciones distintas del CRM a mensajes distintos. Variables:
 * {{campo}} → texto de ese campo/columna; {{nombre}} → nombre del registro.
 */
export interface PlantillaSaliente {
  id: string;
  nombre: string;
  cuerpo: string;
  /** ISO del último disparo de esta plantilla; null si nunca. */
  ultimoDisparoEn?: string | null;
  /** Cómo terminó el último disparo de esta plantilla. */
  ultimoResultado?: ResultadoPlantilla | null;
}

/** Lo que un registro del CRM aporta al render de una plantilla. */
export interface ContextoRender {
  /** Nombre visible del registro (item, deal, contacto…). */
  nombre: string;
  /** Texto de un campo/columna por su id/clave; "" si no existe. */
  campo: (clave: string) => string;
}

/** Reemplaza {{nombre}} y {{campo}} por los valores del registro. */
export function renderCuerpo(cuerpo: string, ctx: ContextoRender): string {
  return cuerpo.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, clave: string) =>
    clave === "nombre" ? ctx.nombre : ctx.campo(clave),
  );
}

/**
 * Migra un doc guardado al modelo de varias plantillas. Un doc viejo tiene
 * un solo campo `plantilla: string`; se convierte en la plantilla por
 * defecto, que sigue respondiendo en la URL corta ya configurada en el
 * CRM, para no romper la automatización existente.
 */
export function normalizarPlantillas(raw: any): PlantillaSaliente[] {
  if (Array.isArray(raw?.plantillas) && raw.plantillas.length > 0) {
    return raw.plantillas as PlantillaSaliente[];
  }
  return [
    {
      id: PLANTILLA_DEFECTO_ID,
      nombre: "Plantilla principal",
      cuerpo: typeof raw?.plantilla === "string" ? raw.plantilla : "",
    },
  ];
}

/** Elige la plantilla por id; si no se pasa, la por defecto o la primera. */
export function elegirPlantilla(
  plantillas: PlantillaSaliente[],
  plantillaId?: string,
): PlantillaSaliente | null {
  if (plantillaId) return plantillas.find((p) => p.id === plantillaId) ?? null;
  return (
    plantillas.find((p) => p.id === PLANTILLA_DEFECTO_ID) ??
    plantillas[0] ??
    null
  );
}

/** Fusiona una lista nueva de plantillas conservando el estado de disparo. */
export function fusionarPlantillas(
  previas: PlantillaSaliente[],
  nuevas: PlantillaSaliente[],
): PlantillaSaliente[] {
  const porId = new Map(previas.map((p) => [p.id, p]));
  return nuevas.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    cuerpo: p.cuerpo,
    ultimoDisparoEn: porId.get(p.id)?.ultimoDisparoEn ?? null,
    ultimoResultado: porId.get(p.id)?.ultimoResultado ?? null,
  }));
}

/** Normaliza un teléfono a solo dígitos (E.164 sin '+'). */
export function soloDigitos(telefono: string): string {
  return telefono.replace(/[^\d]/g, "");
}

/**
 * Rastro observable de un conector para la UI: cuándo llamó el CRM por
 * última vez y cómo terminó el último disparo. Compartido por todos los
 * conectores.
 */
export interface RegistroConector {
  ultimaLlamadaEn: string | null;
  ultimoResultado: ResultadoPlantilla | null;
}
