import type { InstanceEstado } from "@cauce/core";

/** Estado que reporta un transporte; coincide con el estado de la instancia. */
export type TransportStatus = InstanceEstado;

export interface OutgoingMessage {
  /** Teléfono destino en formato E.164. */
  telefono: string;
  cuerpo: string;
}

export interface SendReceipt {
  /** Id que el transporte asigna al mensaje enviado. */
  externalId: string;
  /** ISO 8601 del momento de envío. */
  timestamp: string;
}

/**
 * Contrato único entre el sistema y cualquier canal de mensajería
 * (ver docs/adr/0001). El resto del código importa SOLO esta interfaz;
 * las implementaciones concretas solo se instancian vía `createTransport`.
 */
export interface MessageTransport {
  /** Inicia la sesión. Idempotente si ya está conectando o conectada. */
  connect(): Promise<void>;
  /**
   * Devuelve el payload del QR a escanear, o null si el estado actual
   * no es `qr` (aún no se genera, o la sesión ya conectó).
   */
  getQr(): Promise<string | null>;
  /** Envía un mensaje. Rechaza si el estado no es `connected`. */
  send(mensaje: OutgoingMessage): Promise<SendReceipt>;
  /** Cierra la sesión. Idempotente. */
  disconnect(): Promise<void>;
  status(): TransportStatus;
}
