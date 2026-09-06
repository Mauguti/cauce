import type { MessageTransport } from "./transport.ts";
import { MockTransport, type MockTransportOpciones } from "./mock.ts";
import {
  EvolutionTransport,
  type EvolutionTransportOpciones,
} from "./evolution.ts";

export type {
  MessageTransport,
  OutgoingMessage,
  QrPayload,
  SendReceipt,
  TransportStatus,
} from "./transport.ts";
export type { MockTransportOpciones } from "./mock.ts";
export type { EvolutionTransportOpciones } from "./evolution.ts";
export { mapearEstadoEvolution } from "./evolution.ts";

export type TransportConfig =
  | { tipo: "mock"; opciones?: MockTransportOpciones }
  | { tipo: "evolution"; opciones: EvolutionTransportOpciones };

/**
 * Único punto donde se resuelve una implementación concreta.
 * Fuera de este paquete, nadie importa `MockTransport` ni
 * `EvolutionTransport`: se pide por tipo y se usa por interfaz.
 */
export function createTransport(config: TransportConfig): MessageTransport {
  switch (config.tipo) {
    case "mock":
      return new MockTransport(config.opciones);
    case "evolution":
      return new EvolutionTransport(config.opciones);
  }
}
