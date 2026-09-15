# Recepción de adjuntos: estimado (preliminar, 15-sep-2026)

Reglas ya decididas, no se rediscuten: retención Básico 30 días · Estándar
6 meses · Pro 12 meses; al vencer se borra el archivo y el mensaje queda
con "archivo expirado"; barrido diario con línea en bitácora (cuántos y
cuánto liberó); tope 20 MB por archivo (configurable), arriba del tope no
se guarda y el operador recibe "el contacto envió un archivo de N MB; no
se guardó por tamaño"; tope por cuenta Básico 2 GB · Estándar 10 GB · Pro
25 GB, al llegar se borra lo más antiguo primero, nunca se bloquea la
recepción. Sin medidor ni cobro de almacenamiento.

Este estimado se cierra con las cuatro líneas de las sondas
(`entrante.adjunto_crudo` × 2 y `openlines.adjunto_crudo` × 2). Lo que
cambia según lo que digan está marcado.

## Entrada · WhatsApp → plataforma → Bitrix (3.5 días)

1. Descarga desde Evolution del archivo del mensaje (base64 por API, 0.5 d).
2. Almacenamiento: bucket de GCS en el proyecto de Firebase, objeto con
   nombre no adivinable, metadatos tenant/instancia/conversación/mensaje,
   regla de ciclo de vida por plan (1 d).
3. Entrega a Bitrix por `imconnector.send.messages` con `files[{url,name}]`
   sobre URL pública del bucket. **Depende de la sonda:** si Bitrix
   descarga y guarda en su Disk, la URL puede caducar; si solo enlaza, la
   URL debe vivir lo que dure la retención (0.5 d).
4. Audio: WhatsApp manda notas de voz en OGG/Opus. **Depende de la sonda:**
   si el reproductor de Bitrix no las abre, conversión a MP3 con ffmpeg en
   la EC2 (0.5 d). Una nota de 3 min pesa ~300 KB; el audio no topa.
5. Mensaje con archivo en historial y Trazabilidad, tope de 20 MB con
   aviso al operador, bitácora (1 d).

## Salida · Bitrix → WhatsApp (2 días)

1. El evento `OnImConnectorMessageAdd` con adjunto. **Depende de la
   sonda:** la doc no lo documenta; si el evento trae `files[].link`, es
   una descarga con el token de la app; si no trae nada, hay que consultar
   el mensaje por `im.message.get`/Disk (1 d).
2. Envío por Evolution (`sendMedia` con URL o base64), confirmación a
   Bitrix, registro con origen `operador` (1 d).

## Retención y barrido (1 día)

Job diario en el orquestador: borra por edad según plan, marca "archivo
expirado" en el mensaje, aplica el tope por cuenta borrando lo más
antiguo primero, y deja `adjuntos.barrido` con conteo y bytes liberados.

## Total: 6.5 días, entrada primero

Entrada (3.5) → barrido (1) → salida (2). Con la entrada y el barrido ya
se puede recibir en Bitrix lo que mandan los contactos, que es el caso
que Procesa vive hoy; la salida cierra el ciclo.

**Al desplegar:** el aviso de privacidad cambia de "conservación
indefinida" a estos plazos. Avisar a Mau el día que salga.

**Disco:** crecer el volumen de la EC2 de 18 a 100 GB cuesta ~138 MXN/mes.
Es dinero, no arquitectura.
