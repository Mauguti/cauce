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

## Qué NO hace todavía

- **Leer o escribir en el CRM.** No consulta si el teléfono existe como
  prospecto ni crea uno. El cliente de Bitrix por webhook solo tiene leer
  registro, listar campos y comentar timeline; el de monday, crear update.
  Darle `buscar_prospecto` y `crear_prospecto` son dos métodos en cada
  cliente (`crm.lead.list`/`crm.lead.add`, `items_page_by_column_values`/
  `create_item`) y dos herramientas integradas: medio día por CRM.
- **Marcar el traspaso como atendido.** Hoy caduca a las 12 h; la
  plataforma no lo muestra ni deja cerrarlo.
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

## Bitácora

`entrada.respuesta` (qué pasó con cada entrante), `agente.consumo`,
`agente.traspaso`, `agente.herramienta`, `agente.catalogo_recortado`,
`agente.sin_proveedor`, `agente.configurado`, `openlines.aviso_operadores`.
