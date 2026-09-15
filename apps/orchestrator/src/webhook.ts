import type { Atribucion, InstanceId, Message, TenantId } from "@cauce/core";

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

/**
 * Forma de un payload para la bitácora: mismas claves, pero las cadenas
 * largas (base64, URLs firmadas kilométricas) se sustituyen por su tamaño.
 * Acotado a 2 KB. Para el experimento de multimedia: qué llega y cómo.
 */
export function resumirCrudo(valor: unknown, profundidad = 0): string {
  const reducir = (v: unknown, p: number): unknown => {
    if (typeof v === "string") return v.length > 160 ? `<cadena de ${v.length} caracteres: ${v.slice(0, 40)}…>` : v;
    if (Array.isArray(v)) return p > 4 ? `<array de ${v.length}>` : v.slice(0, 10).map((x) => reducir(x, p + 1));
    if (v && typeof v === "object") {
      if (p > 4) return "<objeto>";
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 40).map(([k, x]) => [k, reducir(x, p + 1)]));
    }
    return v;
  };
  return JSON.stringify(reducir(valor, profundidad)).slice(0, 2048);
}

const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "src"] as const;

/**
 * Atribución de campaña a partir del payload de un entrante. Dos fuentes:
 * 1. Anuncio click-to-WhatsApp: Baileys lo entrega en
 *    `message.*.contextInfo.externalAdReply` (título, sourceUrl, ctwaClid…).
 * 2. Un enlace con parámetros UTM dentro del texto del mensaje.
 * Sin ninguna de las dos, `sin_atribuir` explícito. Nunca se adivina.
 */
export function extraerAtribucion(payload: any, ahora: Date = new Date()): Atribucion {
  const data = payload?.data ?? {};
  const msg = data?.message ?? {};
  const capturadaEn = ahora.toISOString();
  // contextInfo puede venir en cualquiera de los tipos de mensaje.
  let ctx: any = null;
  for (const k of Object.keys(msg)) {
    if (msg[k] && typeof msg[k] === "object" && msg[k].contextInfo && typeof msg[k].contextInfo === "object") { ctx = msg[k].contextInfo; break; }
  }
  const ad = ctx?.externalAdReply && typeof ctx.externalAdReply === "object" ? ctx.externalAdReply : null;
  const texto: string = typeof msg?.conversation === "string" ? msg.conversation : typeof msg?.extendedTextMessage?.text === "string" ? msg.extendedTextMessage.text : "";
  const urlEnTexto = /https?:\/\/[^\s]+/i.exec(texto)?.[0] ?? null;
  const utm: Record<string, string> = {};
  for (const candidata of [ad?.sourceUrl, urlEnTexto]) {
    if (typeof candidata !== "string") continue;
    try {
      const u = new URL(candidata);
      for (const k of UTM) { const v = u.searchParams.get(k); if (v && !utm[k]) utm[k] = v.slice(0, 120); }
    } catch { /* no es URL */ }
  }
  const anuncio = ad
    ? {
        titulo: typeof ad.title === "string" ? ad.title.slice(0, 200) : null,
        cuerpo: typeof ad.body === "string" ? ad.body.slice(0, 300) : null,
        sourceUrl: typeof ad.sourceUrl === "string" ? ad.sourceUrl.slice(0, 500) : null,
        sourceId: typeof ad.sourceId === "string" ? ad.sourceId : null,
        sourceType: typeof ad.sourceType === "string" ? ad.sourceType : null,
        ctwaClid: typeof ad.ctwaClid === "string" ? ad.ctwaClid : typeof ctx?.ctwaClid === "string" ? ctx.ctwaClid : null,
      }
    : null;
  const hayUtm = Object.keys(utm).length > 0;
  if (!anuncio && !hayUtm) return { estado: "sin_atribuir", origen: null, utm: {}, url: urlEnTexto, anuncio: null, capturadaEn };
  const partes: string[] = [];
  if (anuncio) partes.push(`Anuncio click-to-WhatsApp${anuncio.sourceType ? ` (${anuncio.sourceType})` : ""}${anuncio.titulo ? `: ${anuncio.titulo}` : ""}`);
  if (hayUtm) partes.push([utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_content].filter(Boolean).join(" · "));
  return { estado: "atribuida", origen: partes.join(" · ") || null, utm, url: anuncio?.sourceUrl ?? urlEnTexto, anuncio, capturadaEn };
}
