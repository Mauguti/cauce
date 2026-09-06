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
    estado: "delivered",
    externalId: typeof key.id === "string" ? key.id : null,
    timestamp: Number.isFinite(marcaSegundos)
      ? new Date(marcaSegundos * 1000).toISOString()
      : new Date().toISOString(),
  };
}
