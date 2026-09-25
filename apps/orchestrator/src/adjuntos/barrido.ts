import type { Message, Tenant, TenantPlan } from "@cauce/core";
import { RETENCION_DIAS, TOPE_BYTES, normalizarPlan } from "@cauce/core";
import type { Repositorio } from "../store.ts";
import type { AlmacenAdjuntos } from "./almacen.ts";
import { registrar } from "../log.ts";

/**
 * Barrido diario de adjuntos vencidos. Para cada tenant:
 * 1. Borra archivos cuya edad excede la retención del plan.
 * 2. Si aun así el tenant supera su tope, borra los más viejos primero.
 * En ambos casos, el mensaje queda en pie con el adjunto marcado como
 * expirado (nunca se borra un mensaje por retención).
 *
 * Devuelve un resumen por tenant para la bitácora.
 */
export async function barrerAdjuntos(
  repo: Repositorio,
  almacen: AlmacenAdjuntos,
  ahora: Date = new Date(),
): Promise<ResumenBarrido> {
  const tenants = await repo.listTenants();
  let borradosTotal = 0;
  let bytesTotal = 0;

  for (const tenant of tenants) {
    const plan = normalizarPlan(tenant.plan) as TenantPlan;
    const diasRetencion = RETENCION_DIAS[plan];
    const limiteMs = diasRetencion * 86_400_000;
    const topeTenant = TOPE_BYTES[plan];

    // Recoger todos los mensajes con adjuntos activos (no expirados).
    const mensajes = await repo.listMessages(tenant.id);
    const conAdjuntos = mensajes.filter(
      (m) => m.adjuntos?.some((a) => !a.expirado),
    );

    if (conAdjuntos.length === 0) continue;

    // Paso 1: borrar por edad.
    let borradosTenant = 0;
    let bytesTenant = 0;

    for (const msg of conAdjuntos) {
      const adjuntosActualizados = [...(msg.adjuntos ?? [])];
      let cambio = false;

      for (let i = 0; i < adjuntosActualizados.length; i++) {
        const a = adjuntosActualizados[i];
        if (a.expirado) continue;

        const edadMs = ahora.getTime() - new Date(a.guardadoEn).getTime();
        if (edadMs > limiteMs) {
          await almacen.borrar(a.ruta);
          adjuntosActualizados[i] = { ...a, expirado: true };
          borradosTenant++;
          bytesTenant += a.tamano;
          cambio = true;
        }
      }

      if (cambio) {
        await repo.saveMessage({ ...msg, adjuntos: adjuntosActualizados });
      }
    }

    // Paso 2: si el tenant sigue sobre el tope, borrar los más viejos.
    const usoActual = await almacen.usoPorTenant(tenant.id);
    if (usoActual > topeTenant) {
      const { borrados, bytes } = await liberarHastaTope(
        repo,
        almacen,
        tenant,
        usoActual,
        topeTenant,
      );
      borradosTenant += borrados;
      bytesTenant += bytes;
    }

    if (borradosTenant > 0) {
      registrar("adjuntos.barrido", {
        tenant: tenant.id,
        plan,
        borrados: borradosTenant,
        bytesLiberados: bytesTenant,
        mbLiberados: Math.round(bytesTenant / (1024 * 1024) * 100) / 100,
      });
    }

    borradosTotal += borradosTenant;
    bytesTotal += bytesTenant;
  }

  return { borrados: borradosTotal, bytesLiberados: bytesTotal };
}

/** Borra los adjuntos más viejos de un tenant hasta bajar del tope. */
async function liberarHastaTope(
  repo: Repositorio,
  almacen: AlmacenAdjuntos,
  tenant: Tenant,
  usoActual: number,
  tope: number,
): Promise<{ borrados: number; bytes: number }> {
  const mensajes = await repo.listMessages(tenant.id);

  // Recoger todos los adjuntos activos, ordenados por fecha de guardado (más viejo primero).
  const candidatos: { msg: Message; idx: number; adjunto: Message["adjuntos"] extends (infer T)[] | undefined ? NonNullable<T> : never }[] = [];
  for (const msg of mensajes) {
    for (let i = 0; i < (msg.adjuntos?.length ?? 0); i++) {
      const a = msg.adjuntos![i];
      if (!a.expirado) {
        candidatos.push({ msg, idx: i, adjunto: a });
      }
    }
  }
  candidatos.sort((a, b) => new Date(a.adjunto.guardadoEn).getTime() - new Date(b.adjunto.guardadoEn).getTime());

  let restante = usoActual;
  let borrados = 0;
  let bytes = 0;

  for (const c of candidatos) {
    if (restante <= tope) break;
    await almacen.borrar(c.adjunto.ruta);
    const adjuntosActualizados = [...(c.msg.adjuntos ?? [])];
    adjuntosActualizados[c.idx] = { ...c.adjunto, expirado: true };
    await repo.saveMessage({ ...c.msg, adjuntos: adjuntosActualizados });
    restante -= c.adjunto.tamano;
    borrados++;
    bytes += c.adjunto.tamano;
  }

  return { borrados, bytes };
}

export interface ResumenBarrido {
  borrados: number;
  bytesLiberados: number;
}
