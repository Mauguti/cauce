import type {
  MessageTransport,
  OutgoingMessage,
  SendReceipt,
  TransportStatus,
} from "./transport.ts";

export interface MockTransportOpciones {
  /** Milisegundos entre connect() y la emisión del QR. */
  qrDelayMs?: number;
  /** Milisegundos entre el QR y el "escaneo" que conecta la sesión. */
  scanDelayMs?: number;
}

/**
 * Simula en memoria el ciclo completo de una sesión:
 * pending → qr → connected, con envío y desconexión.
 * No toca red ni disco; existe para desarrollar y probar el resto del
 * sistema sin un transporte real.
 */
export class MockTransport implements MessageTransport {
  #estado: TransportStatus = "pending";
  #qr: string | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];
  #enviados = 0;
  readonly #qrDelayMs: number;
  readonly #scanDelayMs: number;

  constructor(opciones: MockTransportOpciones = {}) {
    this.#qrDelayMs = opciones.qrDelayMs ?? 1200;
    this.#scanDelayMs = opciones.scanDelayMs ?? 3500;
  }

  async connect(): Promise<void> {
    if (this.#estado === "qr" || this.#estado === "connected") return;
    this.#estado = "pending";
    this.#timers.push(
      setTimeout(() => {
        this.#estado = "qr";
        this.#qr = `cauce-mock-qr:${Math.random().toString(36).slice(2)}`;
        this.#timers.push(
          setTimeout(() => {
            this.#estado = "connected";
            this.#qr = null;
          }, this.#scanDelayMs),
        );
      }, this.#qrDelayMs),
    );
  }

  async getQr(): Promise<string | null> {
    return this.#estado === "qr" ? this.#qr : null;
  }

  async send(mensaje: OutgoingMessage): Promise<SendReceipt> {
    if (this.#estado !== "connected") {
      throw new Error(
        `No se puede enviar en estado "${this.#estado}"; la sesión debe estar connected`,
      );
    }
    if (!mensaje.telefono || !mensaje.cuerpo) {
      throw new Error("El mensaje requiere telefono y cuerpo");
    }
    this.#enviados += 1;
    return {
      externalId: `mock-${this.#enviados}`,
      timestamp: new Date().toISOString(),
    };
  }

  async disconnect(): Promise<void> {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
    this.#qr = null;
    this.#estado = "disconnected";
  }

  status(): TransportStatus {
    return this.#estado;
  }
}
