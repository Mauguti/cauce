import type { Repositorio } from "./store.ts";
import { registrar } from "./log.ts";

/**
 * Aplica los cambios de plan a la baja cuyo `aplicaEn` ya pasó. Nunca
 * borra configuración: lo que el plan nuevo no incluye queda en pausa
 * por capacidad (ver capacidadesTenant). Idempotente; devuelve cuántos.
 */
export async function aplicarPlanesVencidos(
  repo: Repositorio,
  ahora: Date = new Date(),
): Promise<number> {
  let aplicados = 0;
  for (const t of await repo.listTenants()) {
    const p = t.planPendiente;
    if (!p || new Date(p.aplicaEn) > ahora) continue;
    await repo.saveTenant({ ...t, plan: p.plan, planPendiente: null });
    registrar("plan.aplicado", { tenant: t.id, de: t.plan, a: p.plan, programado: p.aplicaEn });
    aplicados += 1;
  }
  return aplicados;
}
