# Stripe: diseño aprobado y construido (fase 1, 15-sep-2026)

**Estado.** Fase 1 construida en el orquestador (`apps/orchestrator/src/cobro/`:
`cobrador.ts`, `stripe.ts`, `precios.ts`, con pruebas) y en la plataforma
(Billing). Condiciones de aprobación de Mau, todas en código o en este doc:
(1) corrida completa en modo test sobre el tenant de Mau antes de cualquier
llave live; el primer cobro real, Mau a sí mismo; (2) el webhook rechaza
todo lo que no traiga firma válida de Stripe y registra el rechazo con
motivo (`stripe.webhook_rechazado`), sin leer el cuerpo antes; (3) un
reembolso es una fila negativa del ledger vía `registrarPago`, que recorta
`pagadoHasta` los meses devueltos; (4) la verificación de la cuenta de
Stripe México puede bloquear el modo live: lo revisa Mau.

Cuenta de Stripe de Digsol, México, cobros en MXN. Alcance aprobado: método
de pago por tenant con SetupIntent (3DS, sin cargo), cobro recurrente en
cada corte por plan + complementos con descuento de periodo e IVA, prueba
de 14 días al guardar tarjeta, y la transferencia con factura como medio
alterno visible. Fuera: marketplace, cobro a terceros, ligas de cobro para
clientes de nuestros clientes. Orden: cobro recurrente primero, tarjeta
para activar la prueba después.

## Decisión de fondo: PaymentIntents propios, no Subscriptions de Stripe

Stripe ofrece Subscriptions + Invoices con reintentos y correos incluidos,
pero exige que los precios vivan en Stripe (Products/Prices) y crea un
segundo estado ("suscripción activa") que habría que conciliar con el
nuestro. Eso rompe las dos reglas: los montos salen de `lib/precios.ts` y
no puede haber dos verdades sobre quién está al corriente.

Por eso: **Customer + PaymentMethod guardado + un PaymentIntent por corte
que dispara nuestro calendario**, con el monto calculado por nosotros. Los
reintentos y el estado son nuestros y viven donde ya vive `pagadoHasta`.

## 1. Tenant ↔ cliente de Stripe, y las llaves

**Relación.** En el documento del tenant, campo `cobro`:

```
cobro: {
  stripeCustomerId: "cus_…",      // uno por tenant, creado con metadata.tenantId
  metodo: { id: "pm_…", marca: "visa", ultimos4: "4242", vence: "2028-03" } | null,
  periodo: "mensual" | "semestral" | "anual",
  lineasContratadas: 7,           // total; adicionales = total − 1
  agentesContratados: 1,          // adicionales = contratados − incluidos en el plan
  modo: "tarjeta" | "transferencia",
  actualizadoEn
}
```

Ids `cus_`/`pm_` no son secretos, pero son datos del cliente: solo los lee
su propio tenant (reglas existentes) y la plataforma muestra marca y
últimos cuatro. Antes de crear un Customer se busca por `metadata.tenantId`
para que una reinstalación o un reintento no cree dos.

**Llaves.** Tres, en tres lugares distintos, ninguna en el repo:

| Llave | Dónde | Quién la usa |
|---|---|---|
| `STRIPE_SECRET_KEY` (restringida: customers, payment_methods, setup_intents, payment_intents) | `/etc/factory.env` en la EC2 | solo el orquestador |
| `STRIPE_WEBHOOK_SECRET` | `/etc/factory.env` | el orquestador, para verificar la firma de cada webhook |
| `VITE_STRIPE_PUBLISHABLE_KEY` | entorno del build de la plataforma | Stripe.js en el navegador; es pública por diseño |

La plataforma nunca habla con Stripe con secretos: pide al orquestador un
SetupIntent (`POST /api/tenants/:t/cobro/setup-intent` → `client_secret`),
lo confirma con Stripe Elements en el navegador (ahí corre 3DS), y el
orquestador se entera por webhook `setup_intent.succeeded`, no por lo que
diga el navegador. Primero en modo test con llaves de prueba; el prefijo
de la llave (`sk_test_`/`sk_live_`) decide el modo y queda en `/health`.

**Los precios no cruzan a Stripe.** El orquestador necesita el monto para
crear el PaymentIntent, pero no debe tener precios en código. Propuesta:
el build de la plataforma genera `public/precios.json` desde
`lib/precios.ts` (una sola fuente, sin copia a mano) y lo publica junto a
la app; el orquestador lo lee de `CAUCE_PRECIOS_URL` al arrancar y antes
de cada corrida de cobros, y **guarda en cada cobro la foto de precios
que usó** (hash + valores). Si la URL no responde, usa la última foto y lo
registra; si nunca la ha leído, no cobra y avisa.

## 2. Qué pasa cuando falla un cobro recurrente

**El cobro.** Un job diario (como `aplicarPlanesVencidos`) toma los tenants
con `cobro.modo = "tarjeta"` y `cicloCorteEn ≤ hoy`, calcula el total con
`precios.json` (plan + `mensualidadPorLineasTotales` + agentes adicionales,
× meses del periodo × (1 − descuento) × 1.16 de IVA, en centavos MXN) y
crea un PaymentIntent `off_session` con el método guardado. Clave de
idempotencia `tenant:cicloCorteEn`: por más veces que corra el job o se
reintente, un corte nunca se cobra dos veces.

**Si falla**, no se toca nada a mano:

| Día desde el corte | Qué pasa |
|---|---|
| 0 | Fallo. `cobro.fallido` en bitácora (warn) con el código de Stripe. `pagadoHasta` no avanza, así que el tenant queda **vencido** por la regla que ya existe (nivel 1: aviso automático, banner en la plataforma con "no pudimos cobrar tu tarjeta terminada en 4242", CTA para actualizarla; en Bitrix nada). |
| +3 | Reintento automático, misma clave de idempotencia. |
| +7 | Segundo reintento. Si falla: `cobro.agotado` (nivel error) y **aviso a Mau por WhatsApp** a `CAUCE_AVISOS_WHATSAPP`, el mismo canal del cortacircuitos, con tenant, monto, código y días de gracia restantes. |
| gracia (default 10) | Vence la gracia. **La suspensión sigue siendo a mano**, como está decidido: Mau aprieta desde el admin con la evidencia del ledger. |

Casos especiales: `authentication_required` (el banco exige 3DS fuera de
sesión) no se reintenta a ciegas; la plataforma muestra "confirma el pago"
y el cliente lo completa con un clic; `card_declined` sigue el calendario;
tarjeta vencida o método borrado → se marca `cobro.metodo = null` y se
pide una nueva desde el día 0.

Al actualizar la tarjeta, el job vuelve a intentar ese mismo día.

## 3. Conciliación con `pagadoHasta`: un solo camino

Hoy `pagadoHasta` se escribe a mano desde el admin. Eso se termina: **nadie
escribe `pagadoHasta` directamente**. Existe una sola función,
`registrarPago`, y las dos fuentes la llaman:

```
registrarPago(tenantId, {
  fuente: "stripe" | "transferencia",
  referencia: "pi_…" | "folio o referencia bancaria",   // idempotente por referencia
  monto, moneda: "MXN",
  periodo: "mensual" | "semestral" | "anual",
  registradoPor: "stripe:webhook" | "admin:<quién>",
  fotoPrecios: { hash, … },                               // con qué precios se calculó
})
```

Lo que hace, siempre igual:

1. Escribe una fila en `tenants/{t}/pagos/{id}`: ledger **append-only**. Si
   la referencia ya existe, no hace nada (un webhook reenviado o un
   admin que pega dos veces no duplican).
2. Calcula el nuevo `pagadoHasta`: si el anterior sigue vigente **o venció
   dentro de la gracia (10 días)**, suma los meses del periodo desde ahí
   (renovación: el corte cobrado el mismo día no pierde horas y pagar
   tarde dentro de la gracia no regala días); si lleva más tiempo
   vencido, desde la fecha del pago (regularización).
   `cicloCorteEn = pagadoHasta`. Un reembolso resta sus meses desde
   `pagadoHasta` (completo = todos los meses del pago original; parcial,
   en proporción al monto, redondeado al mes; menos de medio mes deja la
   fecha y solo asienta la fila).
3. Bitácora `pago.registrado` con fuente, referencia y hasta cuándo.

**Stripe entra por el webhook** `payment_intent.succeeded`, con firma
verificada, no por la respuesta síncrona del cobro: si el cobro salió
pero perdimos la respuesta, el webhook lo trae igual. **La transferencia
entra por el admin**, que deja de aceptar una fecha y pide folio, monto y
periodo; la fecha se deriva. Uno y otro terminan en la misma fila del
ledger y en el mismo campo. `estadoPago` sigue derivándose de
`pagadoHasta`, sin cambios.

Billing muestra el ledger: fecha, fuente (tarjeta · transferencia),
monto, periodo cubierto, referencia. Esa lista es la única verdad sobre
quién está al corriente, para el cliente y para Mau.

**Rutas.** Tenant (auth de tenant): `GET /api/tenants/:t/cobro` (modo,
periodo, contratación, tarjeta enmascarada, intentos, próximo cobro
cotizado con hash de la foto; nunca `cus_`/`pm_`), `PUT /cobro` (periodo,
líneas y agentes contratados, modo; `tarjeta` exige tarjeta guardada →
409), `POST /cobro/setup-intent` (`client_secret` para Elements),
`GET /pagos` (ledger). Admin (`x-admin-key`):
`POST /api/admin/tenants/:t/pago` con `{folio, montoMxn, periodo,
registradoPor}` (ya no acepta `pagadoHasta`), `POST /reembolso` con
`{referencia, referenciaPago, montoMxn, fuente, registradoPor}`. Público:
`POST /webhooks/stripe` (cuerpo crudo, firma obligatoria).

**Job.** `cobrarCortes` corre cada hora (la clave de idempotencia
`tenant:cicloCorteEn` hace inocuo correrlo seguido); el calendario
0/+3/+7 se mide en días desde el corte. Solo cobra a tenants `activo`, con
`cobro.modo = tarjeta`, tarjeta guardada, plan cobrable y corte vencido.
Bitácora: `cobro.exitoso|fallido|agotado|requiere_accion|en_proceso|
sin_precios|no_cobrable`, `pago.registrado`, `stripe.webhook`.

## CFDI: previsto, no construido

Stripe no emite CFDI. Cada fila del ledger nace con
`cfdi: { estado: "pendiente" }` (o `"no_aplica"` si el tenant así lo pide).
Billing, junto a la tarjeta y junto a la transferencia, dice: **"La
factura se emite por separado"**, sin plazos. Cuando exista el PAC, un
proceso toma las filas `pendiente`, emite y guarda `uuid` y `emitidaEn`;
la emisión se dispara con el pago, sea tarjeta o transferencia, porque
las dos pasan por el mismo ledger. Nada de eso se construye hoy; solo el
campo y el texto.

## Prueba de 14 días con tarjeta (fase 2)

Hoy la prueba arranca al provisionar el tenant. Con esto: el tenant nace
en prueba **sin fecha** (no puede operar) y, al confirmarse el SetupIntent
por webhook, se fija `pruebaExpiraEn = ahora + 14 días`, sin cargo. Al
vencer la prueba con tarjeta guardada, el primer corte cobra el plan que
haya elegido; sin elección, no cobra y queda en solo lectura como hoy.

## Lo que Mau tiene que crear en Stripe antes de que yo codifique

1. Llave secreta **restringida** de prueba y de producción (customers,
   payment_methods, setup_intents, payment_intents: escritura; lo demás
   sin acceso), a `/etc/factory.env`. Nunca por chat.
2. Endpoint de webhook `https://api.factory.digsol.com.mx/webhooks/stripe`
   con `setup_intent.succeeded`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_method.detached`,
   `refund.created`, `charge.refunded`; su secreto al mismo archivo.
4. `CAUCE_PRECIOS_URL` apuntando al `precios.json` publicado por la
   plataforma (ver docs/deploy.md).

## Corrida en modo test (condición 1), paso a paso

1. Llaves `sk_test_…` + `whsec_…` de prueba en `/etc/factory.env`,
   `CAUCE_PRECIOS_URL` y `VITE_STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) en el
   build de la plataforma. `GET /health` debe decir `stripe: "test"`.
2. En Billing del tenant de Mau: "Guardar tarjeta" con la tarjeta de
   prueba `4242 4242 4242 4242`; aparece "visa •••• 4242" tras el webhook
   `setup_intent.succeeded` (bitácora `cobro.metodo_guardado`).
3. Elegir periodo y modo tarjeta; fijar `cicloCorteEn` en el pasado desde
   el admin (o esperar al corte real). A la siguiente corrida del job:
   `cobro.exitoso`, `pago.registrado`, fila en el ledger de Billing y
   `pagadoHasta` movido un periodo.
4. Repetir con la tarjeta `4000 0000 0000 0341` (falla al cobrar):
   `cobro.fallido`, banner de vencido, reintento a +3/+7 y aviso por
   WhatsApp al agotarse.
5. Reembolsar el PaymentIntent desde el panel de Stripe: `refund.created`
   → fila negativa y `pagadoHasta` recortado.
6. Mandar un POST sin firma al webhook: 400 y `stripe.webhook_rechazado`.
Solo entonces llaves live, y el primer cobro real Mau a sí mismo.
3. Llave publicable al entorno del build de la plataforma.

## Estimado

- Fase 1, cobro recurrente: 3 días. Tarjeta guardada (SetupIntent +
  Elements), `precios.json`, job diario, webhook, `registrarPago`
  unificado con ledger, admin de transferencia por folio, Billing con
  tarjeta, próximo cobro, ledger y el texto de CFDI. Modo test primero
  con tu tenant.
- Fase 2, prueba con tarjeta: medio día.
