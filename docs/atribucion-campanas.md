# Atribución de campaña: capa base del plan de conexión

Decidido el 15-sep-2026. Construido en el orquestador (`extraerAtribucion`
en `webhook.ts`, `Conversacion.atribucion`, motor de entrada).

## Por qué va en la capa base y no dentro de Mateo

**La atribución no se reconstruye hacia atrás.** Si el dato solo existiera
cuando un cliente contrata a Mateo, quien lo contrate en el mes seis no
tendría historia que leer. Por eso la plataforma captura y etiqueta desde
el primer mensaje, para todos los planes, y Mateo, cuando exista, solo lee
lo que ya está etiquetado y reporta.

Reparto: la plataforma captura y etiqueta · Santiago trabaja el lead sin
tirar el campo (la calificación en el CRM lleva "Origen de campaña") ·
Mateo lee y reporta.

## Qué se captura, y cuándo

Solo al **primer mensaje** de una conversación; después no se toca.

1. **Anuncio click-to-WhatsApp**: Baileys lo entrega en
   `message.*.contextInfo.externalAdReply` (título, cuerpo, sourceUrl,
   sourceId, sourceType, ctwaClid). Se persiste completo.
2. **Enlace con parámetros** en el texto del mensaje: `utm_source`,
   `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `ref`, `src`.
3. Sin ninguna de las dos: **`sin_atribuir`, explícito.** Nunca se reparte
   ni se adivina. El texto prellenado es editable por el usuario, así que
   un mensaje sin marcas es "no se sabe", no "orgánico".

Bitácora: `entrada.atribucion estado=atribuida|sin_atribuir origen=…`.

## Dónde se ve

- En la conversación (`atribucion`), para cualquier reporte futuro.
- En el CRM: si al primer mensaje la conversación ya está vinculada a un
  registro, se escribe "📣 Origen: …" o "📣 Origen: sin atribuir" en su
  timeline (Bitrix) o update (monday). Si se vincula después, la
  calificación de Santiago lleva la línea "Origen de campaña".

## Límite que no se cruza

Sobre conexión no oficial **no hay `ctwa_clid` confiable**. Se persiste si
viene, pero **no se promete devolver conversiones a Meta**: eso exige un
número en la API oficial. El campo queda guardado para el día que exista.

Mateo, primera fase: solo **lectura** de campañas de Meta. Escribir
campañas exige revisión de app de Meta, con espera que no controlamos.

## No construido a propósito

Reportes. Solo capturar y etiquetar. El reporte, cuando exista, muestra un
cubo de "sin atribuir" visible, nunca repartido entre campañas.
