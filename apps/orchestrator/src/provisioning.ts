import { randomBytes, randomUUID } from "node:crypto";
import { DIAS_PRUEBA, type Tenant } from "@cauce/core";
import { hashApiKey } from "./auth.ts";
import type { Identidad } from "./firebase.ts";
import type { Repositorio } from "./store.ts";

export interface ResultadoProvisioning {
  tenant: Tenant;
  /** API key en claro, SOLO en el alta (nunca se vuelve a mostrar). */
  apiKey: string | null;
}

/**
 * Alta autoservicio de tenants a partir de la identidad de Firebase.
 * Idempotente: el get-or-create atómico del repositorio garantiza un
 * solo tenant por uid aunque el request se reintente o llegue duplicado.
 */
export class Provisioning {
  readonly #repo: Repositorio;

  constructor(repo: Repositorio) {
    this.#repo = repo;
  }

  async provisionar(identidad: Identidad): Promise<ResultadoProvisioning> {
    const apiKey = randomBytes(24).toString("hex");
    let esNuevo = false;

    const tenant = await this.#repo.provisionarTenant(identidad.uid, () => {
      esNuevo = true;
      const ahora = new Date();
      const expira = new Date(ahora.getTime() + DIAS_PRUEBA * 86_400_000);
      return {
        id: randomUUID().slice(0, 8),
        nombre: identidad.nombre ?? identidad.email ?? "Mi cuenta",
        plan: "prueba",
        estado: "activo",
        apiKeyHash: hashApiKey(apiKey),
        pruebaExpiraEn: expira.toISOString(),
        creadoEn: ahora.toISOString(),
      };
    });

    // La API key en claro solo tiene sentido devolverla si es alta nueva
    // (para el tenant existente ya no la conocemos: solo su hash).
    return { tenant, apiKey: esNuevo ? apiKey : null };
  }
}
