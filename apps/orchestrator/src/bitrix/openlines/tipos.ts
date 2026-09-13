/**
 * Canal abierto de Bitrix24 (Contact Center / Open Channels).
 *
 * Módulo APARTE del conector Bitrix existente (webhook entrante + disparos
 * desde el CRM): conviven y no se mezclan. Este exige una aplicación
 * LOCAL de tipo servidor con OAuth y permisos imopenlines, imconnector,
 * im e imbot; la instala el cliente en SU portal (una app por portal).
 */

/** Tokens OAuth de la app local en un portal, tal como los manda Bitrix al instalar. */
export interface TokensOAuth {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms en que caduca el access token. */
  expiraEn: number;
  /** Base REST del portal, p. ej. https://digsol.bitrix24.mx/rest/ */
  clientEndpoint: string;
  /** Dominio del portal, p. ej. digsol.bitrix24.mx */
  dominio: string;
  memberId: string;
  /** application_token con el que Bitrix firma los eventos que nos manda. */
  applicationToken: string;
}

/** Documento `tenants/{t}/conectores/bitrix-openlines`. Los tokens van cifrados. */
export interface OpenlinesBitrixDoc {
  /** Línea (instancia) de WhatsApp que atiende este canal. */
  instanceId: string;
  /** Id del conector registrado en Bitrix (imconnector.register ID). */
  connectorId: string;
  /** Línea abierta a la que se activó el conector; null hasta el placement. */
  lineId: number | null;
  activo: boolean;
  /** JSON de TokensOAuth cifrado con Cripto; "" hasta que el portal instale la app. */
  tokensCifrados: string;
  /** JSON {clientId, clientSecret} de la app local, cifrado con Cripto. */
  appCifrada: string;
  /** Pista legible: dominio del portal. */
  dominio: string;
  /** Id de usuario del imbot de la línea (para reconocer sus mensajes en los eventos); null si no se registró. */
  botId: number | null;
  instaladoEn: string | null;
  actualizadoEn: string;
}

/** Un mensaje que Bitrix nos entrega por OnImConnectorMessageAdd. */
export interface MensajeOperador {
  /** Nuestro chat.id externo: `${instanceId}:${telefono}`. */
  chatExternoId: string;
  imChatId: number;
  imMessageId: number;
  texto: string;
  /** Id de usuario de Bitrix que escribió (operador o bot). */
  userId: number | null;
  /** URLs de adjuntos si el payload trae algo reconocible; vacío si no. */
  archivos: { url: string; nombre: string | null }[];
}

/** chat.id externo estable por conversación: instancia + teléfono. */
export function chatExterno(instanceId: string, telefono: string): string {
  return `${instanceId}:${telefono.replace(/[^\d]/g, "")}`;
}

export function partirChatExterno(chatId: string): { instanceId: string; telefono: string } | null {
  const i = chatId.indexOf(":");
  if (i <= 0) return null;
  const telefono = chatId.slice(i + 1);
  if (!/^\d{10,15}$/.test(telefono)) return null;
  return { instanceId: chatId.slice(0, i), telefono };
}
