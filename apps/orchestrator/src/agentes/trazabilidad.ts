import type { Conversacion, Instance, RegistroConsumo } from "@cauce/core";
import { enmascararTelefono } from "../log.ts";

/**
 * Trazabilidad de agentes, pedazo 2: qué conversaciones atendió cada
 * agente en el mes, con cuántas respuestas, qué herramientas, cuánto costó
 * en pesos, cuánto tardó y si terminó en traspaso. Se arma desde el
 * ledger de consumo (una fila por llamada al modelo) y las conversaciones
 * (donde vive el traspaso). El consumo guarda el teléfono enmascarado, así
 * que la unión es por línea + últimos cuatro dígitos; si dos contactos de
 * la misma línea comparten terminación, se toma el que escribió más
 * recientemente y se marca `telefonoAmbiguo`.
 */
export interface ConversacionAgente {
  clave: string;
  agente: string;
  instanceId: string;
  linea: { nombre: string | null; numero: string | null };
  /** E.164 sin '+' si la conversación se encontró; si no, el enmascarado del consumo. */
  telefono: string;
  telefonoAmbiguo: boolean;
  contacto: string | null;
  respuestas: number;
  llamadas: number;
  errores: number;
  herramientas: Record<string, number>;
  modelos: string[];
  costoUsd: number;
  costoMxn: number;
  msTotal: number;
  msPromedio: number;
  msMaximo: number;
  primeraEn: string;
  ultimaEn: string;
  traspaso: { motivo: string; resumen: string; en: string; agente: string; atendidoEn: string | null } | null;
}

export interface ResumenTrazabilidad {
  mes: string;
  tipoCambio: { usdMxn: number; colchon: number; efectivo: number };
  agentes: string[];
  total: { conversaciones: number; respuestas: number; llamadas: number; errores: number; costoUsd: number; costoMxn: number; traspasos: number };
  conversaciones: ConversacionAgente[];
}

export function resumirTrazabilidad(o: {
  mes: string;
  llamadas: RegistroConsumo[];
  conversaciones: Conversacion[];
  instancias: Instance[];
  tipoCambio: { usdMxn: number; colchon: number };
}): ResumenTrazabilidad {
  const efectivo = Math.round(o.tipoCambio.usdMxn * o.tipoCambio.colchon * 10_000) / 10_000;
  const lineas = new Map(o.instancias.map((i) => [i.id, { nombre: i.nombre ?? null, numero: i.numero ?? null }]));

  // Conversaciones por línea + teléfono enmascarado (como lo guarda el consumo).
  const porMascara = new Map<string, Conversacion[]>();
  for (const c of o.conversaciones) {
    const k = `${c.instanceId}/${enmascararTelefono(c.telefono)}`;
    porMascara.set(k, [...(porMascara.get(k) ?? []), c]);
  }

  const grupos = new Map<string, ConversacionAgente & { _usd: number }>();
  for (const l of [...o.llamadas].sort((a, b) => a.en.localeCompare(b.en))) {
    const clave = `${l.instanceId}/${l.telefono}`;
    let g = grupos.get(clave);
    if (!g) {
      const candidatas = [...(porMascara.get(clave) ?? [])].sort((a, b) => (b.ultimoEntranteEn ?? "").localeCompare(a.ultimoEntranteEn ?? ""));
      const conv = candidatas[0];
      g = {
        clave, agente: l.agente, instanceId: l.instanceId,
        linea: lineas.get(l.instanceId) ?? { nombre: null, numero: null },
        telefono: conv?.telefono ?? l.telefono,
        telefonoAmbiguo: candidatas.length > 1,
        contacto: conv?.nombre ?? null,
        respuestas: 0, llamadas: 0, errores: 0, herramientas: {}, modelos: [],
        costoUsd: 0, costoMxn: 0, msTotal: 0, msPromedio: 0, msMaximo: 0,
        primeraEn: l.en, ultimaEn: l.en,
        traspaso: conv?.traspaso ? { motivo: conv.traspaso.motivo, resumen: conv.traspaso.resumen, en: conv.traspaso.en, agente: conv.traspaso.agente, atendidoEn: conv.traspaso.atendidoEn ?? null } : null,
        _usd: 0,
      };
      grupos.set(clave, g);
    }
    g.llamadas += 1;
    if (l.resultado === "ok") g.respuestas += 1;
    if (l.resultado === "error") g.errores += 1;
    for (const h of l.herramientas ?? []) g.herramientas[h] = (g.herramientas[h] ?? 0) + 1;
    if (!g.modelos.includes(l.modelo)) g.modelos.push(l.modelo);
    g._usd += l.costoUsd ?? 0;
    g.msTotal += l.ms;
    g.msMaximo = Math.max(g.msMaximo, l.ms);
    if (l.en < g.primeraEn) g.primeraEn = l.en;
    if (l.en > g.ultimaEn) g.ultimaEn = l.en;
    // Si atendieron varios agentes (cambio de nombre a mitad de mes), gana el último.
    g.agente = l.agente;
  }

  const conversaciones = [...grupos.values()].map(({ _usd, ...g }) => ({
    ...g,
    costoUsd: Math.round(_usd * 1_000_000) / 1_000_000,
    costoMxn: Math.round(_usd * efectivo * 100) / 100,
    msPromedio: g.llamadas ? Math.round(g.msTotal / g.llamadas) : 0,
  })).sort((a, b) => b.ultimaEn.localeCompare(a.ultimaEn));

  const total = conversaciones.reduce(
    (t, c) => ({
      conversaciones: t.conversaciones + 1, respuestas: t.respuestas + c.respuestas, llamadas: t.llamadas + c.llamadas, errores: t.errores + c.errores,
      costoUsd: t.costoUsd + c.costoUsd, costoMxn: t.costoMxn + c.costoMxn, traspasos: t.traspasos + (c.traspaso ? 1 : 0),
    }),
    { conversaciones: 0, respuestas: 0, llamadas: 0, errores: 0, costoUsd: 0, costoMxn: 0, traspasos: 0 },
  );
  total.costoUsd = Math.round(total.costoUsd * 1_000_000) / 1_000_000;
  total.costoMxn = Math.round(total.costoMxn * 100) / 100;

  return {
    mes: o.mes,
    tipoCambio: { ...o.tipoCambio, efectivo },
    agentes: [...new Set(conversaciones.map((c) => c.agente))].sort(),
    total,
    conversaciones,
  };
}
