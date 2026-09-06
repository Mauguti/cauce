import type { InstanceId, Message, TenantId } from "@cauce/core";

/**
 * Normaliza un evento MESSAGES_UPSERT de Evolution a la forma `Message`
 * de core. Devuelve null si el evento no es un mensaje entrante de texto
 * (mensajes propios, eventos de otro tipo, payloads incompletos).
 *
 * Junto con `mapearEstadoEvolution`, es el otro punto único donde el
 * vocabulario de Evolution se traduce; nada de esto sale de aquí.
 */
export function normalizarEntrante(
  tenantId: TenantId,
  instanceId: InstanceId,
  payload: any,
): Message | null {
  if (payload?.event !== "messages.upsert") return null;
  const data = payload.data;
  const key = data?.key;
  if (!key || key.fromMe === true) return null;

  const remoteJid: unknown = key.remoteJid;
  if (typeof remoteJid !== "string" || !remoteJid.endsWith("@s.whatsapp.net")) {
    return null; // grupos, broadcasts y demás quedan fuera de esta fase
  }
  const telefono = `+${remoteJid.split("@")[0]}`;

  const cuerpo: unknown =
    data?.message?.conversation ?? data?.message?.extendedTextMessage?.text;
  if (typeof cuerpo !== "string" || cuerpo.length === 0) return null;

  const marcaSegundos = Number(data?.messageTimestamp);
  return {
    id: crypto.randomUUID(),
    tenantId,
    instanceId,
    direccion: "in",
    telefono,
    cuerpo,
    estado: "recibido",
    externalId: typeof key.id === "string" ? key.id : null,
    timestamp: Number.isFinite(marcaSegundos)
      ? new Date(marcaSegundos * 1000).toISOString()
      : new Date().toISOString(),
  };
}

/** Resultado de un evento MESSAGES_UPDATE: la entrega real de un saliente. */
export interface ActualizacionEntrega {
  /** key.id del mensaje que asignó Evolution al enviarlo (nuestro externalId). */
  externalId: string;
  /**
   * "confirmado" = WhatsApp acusó recibo (SERVER_ACK o más). "fallido" =
   * Evolution reportó ERROR. Los PENDING no producen actualización (no hay
   * nada que confirmar todavía).
   */
  ack: "confirmado" | "fallido";
}

/**
 * Normaliza un evento MESSAGES_UPDATE de Evolution a la confirmación (o
 * fallo) de entrega de UN saliente. Es lo que distingue "aceptado por el
 * transporte" de "entregado": el bug PENDING se ve justo aquí, como un
 * saliente que nunca produce un SERVER_ACK. Devuelve null si el evento no
 * es una actualización de entrega útil.
 *
 * Estados de Baileys: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK,
 * 4=READ, 5=PLAYED. Evolution los manda como número o string.
 */
export function normalizarActualizacion(
  payload: any,
): ActualizacionEntrega | null {
  if (payload?.event !== "messages.update") return null;
  const data = payload.data;
  const externalId: unknown =
    data?.keyId ?? data?.key?.id ?? data?.messageId;
  if (typeof externalId !== "string" || externalId.length === 0) return null;

  const crudo: unknown = data?.status ?? data?.update?.status;
  const s = typeof crudo === "string" ? crudo.toUpperCase() : crudo;

  const confirmado =
    s === "SERVER_ACK" ||
    s === "DELIVERY_ACK" ||
    s === "READ" ||
    s === "PLAYED" ||
    (typeof s === "number" && s >= 2);
  if (confirmado) return { externalId, ack: "confirmado" };

  const fallido = s === "ERROR" || s === 0;
  if (fallido) return { externalId, ack: "fallido" };

  return null; // PENDING u otro: nada que registrar aún
}
