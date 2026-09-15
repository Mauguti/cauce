import { describe, expect, it } from "vitest";
import type { Conversacion, Instance, RegistroConsumo } from "@cauce/core";
import { idConversacion } from "@cauce/core";
import { resumirTrazabilidad } from "./trazabilidad.ts";

const base = { tenantId: "t1", proveedor: "anthropic", modelo: "claude-opus-5", entrada: 100, salida: 50, cacheLectura: 0, cacheEscritura: 0, error: null } as const;
const llamada = (p: Partial<RegistroConsumo> & Pick<RegistroConsumo, "id" | "en">): RegistroConsumo => ({
  ...base, agente: "Santiago", instanceId: "A", telefono: "521••••0001", costoUsd: 0.01, ms: 1000, resultado: "ok", ...p,
});
const conv = (telefono: string, extra: Partial<Conversacion> = {}): Conversacion => ({
  tenantId: "t1", instanceId: "A", telefono, nombre: null, primerContactoEn: "2026-09-10T00:00:00Z", ultimoEntranteEn: "2026-09-10T00:00:00Z", mondayItemId: null, ...extra,
});
const instancias: Instance[] = [{ id: "A", tenantId: "t1", transportType: "mock", contenedorId: null, numero: "+5214420000009", nombre: "Ventas", estado: "connected", ultimoHeartbeat: null }];

describe("resumirTrazabilidad", () => {
  it("agrupa por conversación: respuestas, herramientas, pesos, tiempos y traspaso con motivo y resumen", () => {
    const r = resumirTrazabilidad({
      mes: "2026-09",
      instancias,
      tipoCambio: { usdMxn: 17.15, colchon: 1.1 },
      conversaciones: [
        conv("5214420000001", { nombre: "Laura", traspaso: { motivo: "pide precio a la medida", resumen: "Quiere 8 líneas para Procesa.", en: "2026-09-12T10:00:00Z", agente: "Santiago" } }),
        conv("5214420000002"),
      ],
      llamadas: [
        llamada({ id: "1", en: "2026-09-12T09:58:00Z", herramientas: ["buscar_prospecto"], ms: 2000 }),
        llamada({ id: "2", en: "2026-09-12T09:59:00Z", herramientas: ["pasar_a_humano", "buscar_prospecto"], ms: 4000, costoUsd: 0.03 }),
        llamada({ id: "3", en: "2026-09-11T09:00:00Z", telefono: "521••••0002", resultado: "error", costoUsd: 0.002, ms: 500 }),
        llamada({ id: "4", en: "2026-09-11T09:01:00Z", telefono: "521••••0002", ms: 1500 }),
      ],
    });
    expect(r.agentes).toEqual(["Santiago"]);
    expect(r.tipoCambio.efectivo).toBe(18.865);
    expect(r.conversaciones).toHaveLength(2);
    const [laura, otra] = r.conversaciones;
    expect(laura).toMatchObject({
      telefono: "5214420000001", contacto: "Laura", telefonoAmbiguo: false, linea: { nombre: "Ventas", numero: "+5214420000009" },
      respuestas: 2, llamadas: 2, errores: 0, herramientas: { buscar_prospecto: 2, pasar_a_humano: 1 },
      costoUsd: 0.04, costoMxn: 0.75, msTotal: 6000, msPromedio: 3000, msMaximo: 4000,
      primeraEn: "2026-09-12T09:58:00Z", ultimaEn: "2026-09-12T09:59:00Z",
    });
    expect(laura!.traspaso).toEqual({ motivo: "pide precio a la medida", resumen: "Quiere 8 líneas para Procesa.", en: "2026-09-12T10:00:00Z", agente: "Santiago", atendidoEn: null });
    expect(otra).toMatchObject({ telefono: "5214420000002", respuestas: 1, llamadas: 2, errores: 1, traspaso: null, costoMxn: 0.23 });
    expect(r.total).toEqual({ conversaciones: 2, respuestas: 3, llamadas: 4, errores: 1, costoUsd: 0.052, costoMxn: 0.98, traspasos: 1 });
  });

  it("con conversacionId la unión es exacta aunque dos contactos compartan terminación", () => {
    const r = resumirTrazabilidad({
      mes: "2026-09", instancias, tipoCambio: { usdMxn: 17.15, colchon: 1.1 },
      conversaciones: [
        conv("5214420000001", { nombre: "Vieja", ultimoEntranteEn: "2026-09-01T00:00:00Z" }),
        conv("5215550000001", { nombre: "Reciente", ultimoEntranteEn: "2026-09-13T00:00:00Z" }),
      ],
      llamadas: [llamada({ id: "1", en: "2026-09-13T00:00:00Z", conversacionId: idConversacion("t1", "A", "5214420000001") })],
    });
    expect(r.conversaciones).toHaveLength(1);
    expect(r.conversaciones[0]).toMatchObject({ telefono: "5214420000001", contacto: "Vieja", telefonoAmbiguo: false });
    expect(idConversacion("t1", "A", "+5214420000001")).toBe(idConversacion("t1", "A", "5214420000001"));
    expect(idConversacion("t1", "A", "5214420000001")).not.toBe(idConversacion("t1", "B", "5214420000001"));
  });

  it("filas viejas sin conversacionId: sin conversación conocida deja el teléfono enmascarado; con dos que comparten terminación marca ambigüedad y toma la más reciente", () => {
    const r = resumirTrazabilidad({
      mes: "2026-09", instancias, tipoCambio: { usdMxn: 17.15, colchon: 1.1 },
      conversaciones: [
        conv("5214420000001", { ultimoEntranteEn: "2026-09-01T00:00:00Z" }),
        conv("5215550000001", { nombre: "Reciente", ultimoEntranteEn: "2026-09-13T00:00:00Z" }),
      ],
      llamadas: [llamada({ id: "1", en: "2026-09-13T00:00:00Z" }), llamada({ id: "2", en: "2026-09-13T00:00:00Z", telefono: "521••••9999" })],
    });
    const ambigua = r.conversaciones.find((c) => c.clave === "A/521••••0001")!;
    expect(ambigua.telefonoAmbiguo).toBe(true);
    expect(ambigua.telefono).toBe("5215550000001");
    const sinConv = r.conversaciones.find((c) => c.clave === "A/521••••9999")!;
    expect(sinConv.telefono).toBe("521••••9999");
    expect(sinConv.contacto).toBeNull();
  });
});
