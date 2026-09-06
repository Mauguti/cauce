import type { Instance } from "@cauce/core";
import { createTransport, type MessageTransport } from "@cauce/transports";

/**
 * Raíz de composición de la consola: el único lugar de la app que sabe
 * qué tipo de transporte se instancia. Los componentes reciben la
 * interfaz `MessageTransport` y nada más.
 *
 * TODO: cuando el orquestador exponga sesiones reales, esto se
 * sustituye por llamadas a su API; la pantalla no cambia.
 */

export const TENANT_DEMO = "demo";

const semilla: Instance[] = [
  {
    id: "inst-1",
    tenantId: TENANT_DEMO,
    transportType: "mock",
    contenedorId: null,
    numero: "+52 55 1234 5678",
    estado: "pending",
    ultimoHeartbeat: null,
  },
  {
    id: "inst-2",
    tenantId: TENANT_DEMO,
    transportType: "mock",
    contenedorId: null,
    numero: "+52 81 9876 5432",
    estado: "pending",
    ultimoHeartbeat: null,
  },
  {
    id: "inst-3",
    tenantId: TENANT_DEMO,
    transportType: "mock",
    contenedorId: null,
    numero: "+52 33 5555 0101",
    estado: "pending",
    ultimoHeartbeat: null,
  },
];

export interface Sesion {
  instancia: Instance;
  transporte: MessageTransport;
}

export function crearSesionesDemo(): Sesion[] {
  return semilla.map((instancia, i) => ({
    instancia,
    transporte: createTransport({
      tipo: "mock",
      opciones: {
        // Ritmos distintos para ver el ciclo avanzar de forma escalonada.
        qrDelayMs: 800 + i * 900,
        scanDelayMs: 2600 + i * 1400,
      },
    }),
  }));
}
