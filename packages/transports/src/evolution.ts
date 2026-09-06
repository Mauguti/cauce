import type {
  MessageTransport,
  OutgoingMessage,
  QrPayload,
  SendReceipt,
  TransportStatus,
} from "./transport.ts";

export interface EvolutionTransportOpciones {
  /**
   * URL base alcanzable por el orquestador para ESTA instancia
   * (p. ej. http://127.0.0.1:49321). El transporte no sabe ni le
   * importa cómo se resolvió esa reachability; eso es del DockerManager.
   */
  baseUrl: string;
  /** API key propia de la instancia (AUTHENTICATION_API_KEY del contenedor). */
  apiKey: string;
  /** Nombre de la instancia dentro de Evolution. */
  instanceName: string;
  /**
   * URL (con token incluido) a la que Evolution manda los eventos de
   * mensajes. Se registra en connect() vía /webhook/set: el webhook
   * global por variables de entorno no dispara en v2.3.7 (verificado).
   */
  webhookUrl?: string;
  /** Timeout por llamada HTTP, ms. */
  timeoutMs?: number;
  /** Inyectable para pruebas. */
  fetchImpl?: typeof fetch;
}

/**
 * Estados que reporta Evolution v2 en /instance/connectionState.
 * Verificados contra una instancia real de v2.3.7 (no asumidos de docs).
 */
type EstadoEvolution = "open" | "connecting" | "close";

/**
 * ÚNICO punto donde el vocabulario de Evolution se traduce al enum de
 * core. Nada fuera de este archivo ve "open"/"connecting"/"close".
 *
 * `connecting` es ambiguo en Evolution: cubre tanto "arrancando" como
 * "QR en pantalla esperando escaneo"; se desambigua con `hayQr`.
 */
export function mapearEstadoEvolution(
  estado: string,
  hayQr: boolean,
): TransportStatus {
  switch (estado as EstadoEvolution) {
    case "open":
      return "connected";
    case "close":
      return "disconnected";
    case "connecting":
      return hayQr ? "qr" : "pending";
    default:
      return "pending";
  }
}

export class EvolutionTransport implements MessageTransport {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #instanceName: string;
  readonly #webhookUrl: string | null;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opciones: EvolutionTransportOpciones) {
    this.#baseUrl = opciones.baseUrl.replace(/\/$/, "");
    this.#apiKey = opciones.apiKey;
    this.#instanceName = opciones.instanceName;
    this.#webhookUrl = opciones.webhookUrl ?? null;
    this.#timeoutMs = opciones.timeoutMs ?? 15_000;
    this.#fetch = opciones.fetchImpl ?? fetch;
  }

  async #llamar(
    metodo: "GET" | "POST" | "DELETE",
    ruta: string,
    cuerpo?: unknown,
  ): Promise<{ status: number; json: any }> {
    const init: RequestInit = {
      method: metodo,
      headers: {
        apikey: this.#apiKey,
        ...(cuerpo !== undefined ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (cuerpo !== undefined) init.body = JSON.stringify(cuerpo);
    const res = await this.#fetch(`${this.#baseUrl}${ruta}`, init);
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // Algunas respuestas de error no traen JSON; se reporta por status.
    }
    return { status: res.status, json };
  }

  async connect(): Promise<void> {
    // El contenedor corre una sola instancia; si ya existe, conectar de
    // nuevo es pedir sesión otra vez, no un error.
    const creacion = await this.#llamar("POST", "/instance/create", {
      instanceName: this.#instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    });
    if (creacion.status === 403 || creacion.status === 409) {
      const conexion = await this.#llamar(
        "GET",
        `/instance/connect/${this.#instanceName}`,
      );
      if (conexion.status >= 400) {
        throw new Error(
          `Evolution rechazó connect (${conexion.status}): ${JSON.stringify(conexion.json)}`,
        );
      }
    } else if (creacion.status >= 400) {
      throw new Error(
        `Evolution rechazó create (${creacion.status}): ${JSON.stringify(creacion.json)}`,
      );
    }
    await this.#registrarWebhook();
  }

  /**
   * Registra el webhook de la instancia. Forma del cuerpo verificada
   * contra v2.3.7 real (POST /webhook/set con objeto `webhook` anidado;
   * queda persistido y sobrevive reinicios del contenedor).
   */
  async #registrarWebhook(): Promise<void> {
    if (!this.#webhookUrl) return;
    const res = await this.#llamar("POST", `/webhook/set/${this.#instanceName}`, {
      webhook: {
        enabled: true,
        url: this.#webhookUrl,
        events: ["MESSAGES_UPSERT"],
        byEvents: false,
        base64: false,
      },
    });
    if (res.status >= 400) {
      throw new Error(
        `Evolution rechazó webhook/set (${res.status}): ${JSON.stringify(res.json)}`,
      );
    }
  }

  async getQr(): Promise<QrPayload | null> {
    const res = await this.#llamar(
      "GET",
      `/instance/connect/${this.#instanceName}`,
    );
    if (res.status >= 400) return null;
    // Conectada: Evolution responde {instance:{...}} sin code/base64.
    const codigo = res.json?.code;
    if (typeof codigo !== "string" || codigo.length === 0) return null;
    const base64 = res.json?.base64;
    return {
      codigo,
      imagenBase64: typeof base64 === "string" ? base64 : null,
    };
  }

  async send(mensaje: OutgoingMessage): Promise<SendReceipt> {
    if (!mensaje.telefono || !mensaje.cuerpo) {
      throw new Error("El mensaje requiere telefono y cuerpo");
    }
    const estado = await this.status();
    if (estado !== "connected") {
      throw new Error(
        `No se puede enviar en estado "${estado}"; la sesión debe estar connected`,
      );
    }
    const res = await this.#llamar(
      "POST",
      `/message/sendText/${this.#instanceName}`,
      {
        number: mensaje.telefono.replace(/[^\d]/g, ""),
        text: mensaje.cuerpo,
      },
    );
    if (res.status >= 400) {
      throw new Error(
        `Evolution rechazó sendText (${res.status}): ${JSON.stringify(res.json)}`,
      );
    }
    const marcaSegundos = Number(res.json?.messageTimestamp);
    return {
      externalId: res.json?.key?.id ?? "",
      timestamp: Number.isFinite(marcaSegundos)
        ? new Date(marcaSegundos * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  async disconnect(): Promise<void> {
    const res = await this.#llamar(
      "DELETE",
      `/instance/logout/${this.#instanceName}`,
    );
    // 404 = la instancia no existe o ya está fuera; disconnect es idempotente.
    if (res.status >= 400 && res.status !== 404 && res.status !== 400) {
      throw new Error(
        `Evolution rechazó logout (${res.status}): ${JSON.stringify(res.json)}`,
      );
    }
  }

  async status(): Promise<TransportStatus> {
    let res;
    try {
      res = await this.#llamar(
        "GET",
        `/instance/connectionState/${this.#instanceName}`,
      );
    } catch {
      // Contenedor caído o inalcanzable: para el sistema, desconectada.
      return "disconnected";
    }
    if (res.status === 404) return "pending"; // instancia aún no creada
    if (res.status >= 400) return "disconnected";
    const estado = res.json?.instance?.state;
    if (estado === "connecting") {
      const qr = await this.getQr();
      return mapearEstadoEvolution(estado, qr !== null);
    }
    return mapearEstadoEvolution(String(estado), false);
  }

  async numero(): Promise<string | null> {
    // El número de la cuenta conectada sale del ownerJid que reporta
    // fetchInstances (p. ej. "5215512345678@s.whatsapp.net").
    let res;
    try {
      res = await this.#llamar(
        "GET",
        `/instance/fetchInstances?instanceName=${encodeURIComponent(this.#instanceName)}`,
      );
    } catch {
      return null;
    }
    if (res.status >= 400) return null;
    const lista = Array.isArray(res.json) ? res.json : [res.json];
    const jid: unknown =
      lista[0]?.ownerJid ?? lista[0]?.instance?.owner ?? lista[0]?.owner;
    if (typeof jid !== "string") return null;
    const digitos = jid.split("@")[0]?.replace(/[^\d]/g, "");
    return digitos ? `+${digitos}` : null;
  }
}
