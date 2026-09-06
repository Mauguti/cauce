import { envioSinConfirmar, UMBRAL_SIN_CONFIRMAR_MS } from "@cauce/core";
import type { Repositorio } from "./store.ts";

/**
 * Pasa a `no_confirmado` los salientes que Cauce dio por `enviado` (el
 * transporte los aceptó con 201) pero que Evolution nunca confirmó
 * (SERVER_ACK) tras el umbral. Es lo que hoy costó horas: la consola decía
 * "enviado" cuando nada salía. Idempotente; se corre cada minuto.
 *
 * Devuelve cuántos mensajes marcó.
 */
export async function barrerSinConfirmar(
  repo: Repositorio,
  ahora: Date = new Date(),
  umbralMs: number = UMBRAL_SIN_CONFIRMAR_MS,
): Promise<number> {
  let marcados = 0;
  for (const tenant of await repo.listTenants()) {
    for (const m of await repo.listMessages(tenant.id)) {
      if (!envioSinConfirmar(m, ahora, umbralMs)) continue;
      await repo.saveMessage({ ...m, estado: "no_confirmado" });
      marcados += 1;
    }
  }
  return marcados;
}
