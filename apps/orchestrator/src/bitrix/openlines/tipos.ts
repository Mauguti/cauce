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

/** Una asignación: el número (instancia) atiende exactamente esta línea abierta. */
export interface AsignacionLinea {
  lineId: number;
  asignadaEn: string;
}

/**
 * Documento `tenants/{t}/conectores/bitrix-openlines`. Los tokens van cifrados.
 *
 * Modelo de líneas (aprobado 14-sep-2026): cada número atiende exactamente
 * UNA línea abierta; una línea abierta puede tener VARIOS números, a
 * propósito y con confirmación. Un número en varias líneas no existe: el
 * entrante no sabría a cuál ir.
 */
export interface OpenlinesBitrixDoc {
  /** Id del conector registrado en Bitrix (imconnector.register ID). Uno por tenant. */
  connectorId: string;
  /** instanceId → línea abierta que atiende. */
  asignaciones: Record<string, AsignacionLinea>;
  /** JSON de TokensOAuth cifrado con Cripto; "" hasta que el portal instale la app. */
  tokensCifrados: string;
  /** JSON {clientId, clientSecret} de la app local, cifrado con Cripto. */
  appCifrada: string;
  /**
   * Dominio del portal que el tenant declaró al dar de alta (p. ej.
   * digsol.bitrix24.mx). La instalación SOLO se acepta desde ese portal:
   * es lo que impide que un tercero, conociendo el tenantId, "instale"
   * su propio portal y se lleve los WhatsApp del cliente.
   */
  dominio: string;
  /** Id de usuario del imbot de la línea (para reconocer sus mensajes en los eventos); null si no se registró. */
  botId: number | null;
  instaladoEn: string | null;
  actualizadoEn: string;
}

/** Forma anterior del documento (un solo número por tenant). Se migra al leer. */
export interface OpenlinesDocLegado {
  instanceId?: string;
  lineId?: number | null;
  activo?: boolean;
}

/**
 * Normaliza lo que haya en Firestore a la forma vigente. El doc legado
 * (instanceId + lineId + activo) se convierte en una asignación; al
 * volver a guardar, los campos viejos desaparecen.
 */
export function normalizarOpenlinesDoc(bruto: (Partial<OpenlinesBitrixDoc> & OpenlinesDocLegado) | null | undefined): OpenlinesBitrixDoc | null {
  if (!bruto) return null;
  const ahora = new Date().toISOString();
  const asignaciones: Record<string, AsignacionLinea> = {};
  for (const [i, a] of Object.entries(bruto.asignaciones ?? {})) {
    if (a && Number.isFinite(Number(a.lineId))) asignaciones[i] = { lineId: Number(a.lineId), asignadaEn: a.asignadaEn ?? ahora };
  }
  if (bruto.instanceId && bruto.activo && typeof bruto.lineId === "number" && !asignaciones[bruto.instanceId]) {
    asignaciones[bruto.instanceId] = { lineId: bruto.lineId, asignadaEn: bruto.actualizadoEn ?? ahora };
  }
  return {
    connectorId: bruto.connectorId ?? "",
    asignaciones,
    tokensCifrados: bruto.tokensCifrados ?? "",
    appCifrada: bruto.appCifrada ?? "",
    dominio: bruto.dominio ?? "",
    botId: bruto.botId ?? null,
    instaladoEn: bruto.instaladoEn ?? null,
    actualizadoEn: bruto.actualizadoEn ?? ahora,
  };
}

/** Línea abierta que atiende el número, o null si no está asignado. */
export function lineaDe(doc: OpenlinesBitrixDoc, instanceId: string): number | null {
  return doc.asignaciones[instanceId]?.lineId ?? null;
}

/** Números asignados a una línea abierta, ordenados. */
export function instanciasEnLinea(doc: OpenlinesBitrixDoc, lineId: number): string[] {
  return Object.entries(doc.asignaciones)
    .filter(([, a]) => a.lineId === lineId)
    .map(([i]) => i)
    .sort();
}

/** `+5214421234567` → `+521 442 123 4567`; `+524421234567` → `+52 442 123 4567`. */
export function formatearNumero(numero: string | null | undefined): string | null {
  if (!numero) return null;
  const d = numero.replace(/[^\d]/g, "");
  if (d.length < 8) return `+${d}`;
  const nacional = d.slice(-10);
  const prefijo = d.slice(0, -10);
  return `+${prefijo} ${nacional.slice(0, 3)} ${nacional.slice(3, 6)} ${nacional.slice(6)}`.replace(/\s+/g, " ").trim();
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
