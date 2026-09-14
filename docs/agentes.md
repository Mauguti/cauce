# Agentes: Santiago y los que sigan

Estado al 14-sep-2026. El agente razona en el orquestador
(`apps/orchestrator/src/agentes/`); n8n u otro servicio pueden ser
herramientas que el agente invoca por webhook, nunca el lugar donde piensa.

## Qué hace hoy

- **Contesta entrantes** cuando ningún disparador coincidió, el plan incluye
  `agentes` (Pro) y la conversación no está en ventana humana. Responde por
  el carril inmediato y se refleja en el chat de Bitrix si hay canal abierto
  con bot conectado.
- **Base de conocimiento**: el ADN del Centro de Conocimiento. Radiografía,
  Identidad, Líneas Rojas y Voz van completos en cada consulta como prefijo
  cacheado; el Catálogo completo hasta 40 mil caracteres, recortado y
  avisado después (`agente.catalogo_recortado`). Recuperación por
  relevancia solo cuando ese aviso aparezca.
- **Herramientas** (interfaz en `proveedor.ts`, ciclo de hasta 4 rondas):
  - `pasar_a_humano(motivo, resumen)`, integrada y siempre presente. Marca
    `Conversacion.traspaso`, calla al agente 12 h, avisa en el chat de
    Bitrix como bot, deja nota en el registro del CRM vinculado (Bitrix o
    monday) y registra `agente.traspaso … avisadoEn=`. El sistema le
    instruye usarla ante intención de compra, petición de persona, queja o
    pregunta fuera de alcance, y despedirse sin prometer tiempos.
  - **Webhook del tenant** (`agente.herramientas[]`): POST JSON con
    `{tenantId, instanceId, telefono, contacto, herramienta, argumentos}`,
    Bearer cifrado, 10 s de tope. La respuesta vuelve al modelo.
- **Contabilidad**: cada llamada en `tenants/{t}/consumo/{YYYY-MM}` (agregado)
  y `…/llamadas/{id}` (detalle: tokens, caché, costo USD, ms, resultado,
  herramientas), y en bitácora `agente.consumo`. Se registra también en
  error. Se cobra después, sobre estos datos.

### CRM: enriquecer, no crear (decidido 14-sep-2026)

Santiago **no crea prospectos**: el conector del canal abierto ya crea y
fusiona el prospecto cuando entra el mensaje. Con un CRM conectado en el
tenant (Bitrix tiene prioridad si hay ambos) el agente tiene dos
herramientas más:

- `buscar_prospecto`: por teléfono, con las variantes +521/521/+52/52
  (`crm.duplicate.findbycomm` en Bitrix, primero lead y luego contact;
  `items_page_by_column_values` sobre el board y la columna de teléfono
  en monday). Trae nombre, etapa y responsable, y vincula la conversación
  al registro para que el traspaso caiga ahí.
- `calificar_prospecto`: deja la calificación como **comentario en el
  timeline** del registro (update en monday), sin campos personalizados:
  CRM actual · números de WhatsApp · personas que contestan · herramienta y
  costo hoy · **Encaje** (Bitrix → Estándar completo; monday → solo
  salientes; sin CRM → proponer Bitrix). Si aún no hay registro, la
  calificación vuelve al modelo para el resumen del traspaso.

Bitácora: `agente.prospecto`, `agente.calificacion`.

## Qué NO hace todavía

- **Cerrar el traspaso.** Nadie lo marca como atendido: caduca a las 12 h y
  la plataforma no lo muestra. Para el dogfooding aguanta porque Mau es el
  único vendedor y el aviso en Bitrix es su cola. **Disparador: ANTES de que
  un cliente con más de un vendedor tenga agentes.** Lo que se construye
  entonces: estado atendido, quién lo tomó, cuándo, y una vista en la
  plataforma con los traspasos abiertos; el aviso en Bitrix se conserva.
- **Campos estructurados de calificación** en el CRM: solo si hacen falta
  para reportes, con evidencia.
- **Multimedia**: solo texto, como todo el sistema.

## Modelo por defecto

Configurable por tenant (`agente.modelo`). El default hoy es
`claude-opus-5`, **a propósito para el dogfooding de Digsol**: se quiere ver
el techo de calidad y luego comparar las mismas conversaciones con
`claude-sonnet-5` y `claude-haiku-4-5` con tráfico real. **El default de
producción para vender Pro se decide con esa comparación, no antes.** Con
los precios de la tabla en `proveedor.ts`, una respuesta típica (~2,500
tokens de entrada, casi todos en caché, 100 de salida) cuesta ~$0.15 MXN
en Opus, ~$0.07 en Sonnet y ~$0.03 en Haiku; a 3,000 respuestas al mes,
Opus rebasa la bolsa de $200 de un agente Pro antes de mitad de mes.

## Habilitar en un tenant

1. `ANTHROPIC_API_KEY` en `/etc/factory.env` (la paga Digsol por ahora).
2. Plan Pro en el tenant: `POST /api/admin/tenants/<t>/plan {"plan":"pro"}`.
3. `POST /api/admin/tenants/<t>/agente {"nombre":"Santiago"}`; opcionales
   `modelo`, `esfuerzo` (low|medium|high), `maxSalida`, `instrucciones`,
   `herramientas:[{nombre, descripcion, url, parametros, token}]`.
4. ADN lleno en el Centro de Conocimiento por un usuario del tenant.

## Consumo en pesos: tipo de cambio

El costo se registra en USD y se muestra en MXN con `CAUCE_USD_MXN` y el
colchón multiplicativo `CAUCE_USD_MXN_COLCHON` (defaults 17.15 y 1.10,
≈18.9 efectivo). **Se revisa cada mes**: el peso se mueve y un default
viejo infla o adelgaza lo que ve el cliente. Fijado el 15-sep-2026 con el
dólar a 17.13.

## Origen de cada saliente

Todo mensaje saliente lleva `origen`: `agente`, `bot`, `operador` (desde
el Contact Center), `crm` (disparo de monday/Bitrix), `manual` (plataforma
o API) o `sistema` (avisos). Trazabilidad → Mensajes lo muestra junto a
"SALE" y filtra por "Agente": así se revisa qué contestó Santiago sin
entrar al journal. Mensajes anteriores a este campo no lo tienen.

## Anti-bucle

- **Línea propia:** si el remitente es una línea conectada de cualquier
  tenant (registro `numeros/{dígitos}`, con variantes +521/+52), ni bots ni
  agente responden; el mensaje se guarda y se espeja al CRM. Sin esto, dos
  líneas con agente se contestan entre sí para siempre.
- **Cortacircuitos por conversación** (`CORTACIRCUITOS` en motor.ts): más
  de 12 respuestas automáticas en 10 min sin humano, o 3 idénticas seguidas
  en menos de 3 min → `autoPausadaHasta` 6 h, `cortacircuitos.disparado` en
  bitácora (nivel error) y aviso por WhatsApp a `CAUCE_AVISOS_WHATSAPP`
  desde la misma línea. Un operador que contesta (ventana humana) levanta la
  pausa. Es independiente del filtro anterior: cubre contestadores, otros
  bots o sistemas de tickets del otro lado.
- **Eco del reflejo:** lo que el orquestador escribe como bot vuelve por
  OnImConnectorMessageAdd con `user_id=0` (journal del 15-sep; una persona
  trae su id). Filtro primario: `usuario=0` se ignora siempre; respaldo: el
  texto escrito como bot se recuerda 10 min y también se ignora si vuelve.
  Un eco nunca cuenta como intervención humana: no se entrega, no se
  confirma y no fija la ventana humana (antes el bot se callaba a sí mismo
  30 min con cada respuesta).

## Bitácora

`entrada.respuesta` (qué pasó con cada entrante), `agente.consumo`,
`agente.traspaso`, `agente.herramienta`, `agente.catalogo_recortado`,
`agente.sin_proveedor`, `agente.configurado`, `openlines.aviso_operadores`,
`cortacircuitos.disparado`, `cortacircuitos.aviso_fallido`.
