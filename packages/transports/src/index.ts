import type { TransportType } from "@cauce/core";
import type { MessageTransport } from "./transport.ts";
import { MockTransport, type MockTransportOpciones } from "./mock.ts";

export type {
  MessageTransport,
  OutgoingMessage,
  SendReceipt,
  TransportStatus,
} from "./transport.ts";
export type { MockTransportOpciones } from "./mock.ts";

/**
 * Único punto donde se resuelve una implementación concreta.
 * Fuera de este paquete, nadie importa `MockTransport` ni ninguna
 * implementación futura: se pide por tipo y se usa por interfaz.
 */
export function createTransport(
  tipo: TransportType,
  opciones: MockTransportOpciones = {},
): MessageTransport {
  switch (tipo) {
    case "mock":
      return new MockTransport(opciones);
  }
}
