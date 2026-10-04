# B1 — Inventario: Cobrador hoy y plan de obsolescencia

## Lo que existe hoy (Fase 1)

### Flujo de cobro con tarjeta
- **SetupIntent** para guardar tarjeta sin cobrar (`cobrador.ts:233`)
- **PaymentIntent** directo en `#cobrarCorte()` (`cobrador.ts:291`)
- **`cobrarCortes()`** — job diario que busca tenants con `modo=tarjeta`,
  `metodo` guardado, `cicloCorteEn <= ahora`, `estado=activo` (`cobrador.ts:268`)
- Calendario de reintentos propio: `REINTENTOS_DIAS = [0, 3, 7]` (`cobrador.ts:23`)
- `GRACIA_DIAS = 10` (`cobrador.ts:20`)
- Avisos WhatsApp a Mau cuando se agotan reintentos o tarjeta inválida

### Ledger y registro de pagos
- **`registrarPago()`** — único camino a `pagadoHasta` (`cobrador.ts:104`)
- Idempotencia por `(fuente, referencia)`
- `registrarTransferencia()` — wrapper para transferencias manuales
- `registrarReembolso()` — entradas negativas en el ledger

### Webhooks actuales
| Evento | Acción |
|--------|--------|
| `setup_intent.succeeded` | Guarda método de pago |
| `payment_intent.succeeded` | `registrarPago()` |
| `payment_intent.payment_failed` | Bitacorea fallo |
| `payment_method.detached` | Limpia `metodo` |
| `refund.created/updated` | `registrarReembolso()` |
| `charge.refunded` | Procesa lista de reembolsos |

### Cliente Stripe (`stripe.ts`)
- Interfaz `ClienteStripe` con 6 métodos
- `ClienteStripeReal`: asegurarCliente, crearSetupIntent, cobrar, construirEvento
- Modo inferido del prefijo de la llave (`sk_test_` / `sk_live_`)

### Frontend (digsol-factory)
- `TarjetaStripe.tsx`: Stripe Elements con SetupIntent
- `BillingModule.tsx`: selector de periodo, método, breakdown, ledger
- Polling de 15 s para confirmar tarjeta vía webhook
- Confirmación 3DS para `requiereAccion`

---

## Qué queda obsoleto con Decisión 1 (Subscriptions único camino)

### En `cobrador.ts`
| Líneas | Función | Motivo |
|--------|---------|--------|
| 268-289 | `cobrarCortes()` | Subscriptions de Stripe cobra solo; el job ya no es necesario para tenants con suscripción |
| 291-351 | `#cobrarCorte()` | PaymentIntent directo reemplazado por Invoice de Subscription |
| 23 | `REINTENTOS_DIAS = [0, 3, 7]` | Dunning de Stripe maneja los reintentos |
| 233-247 | `crearSetupIntent()` | Checkout Session captura la tarjeta al suscribirse |

### En `stripe.ts`
| Líneas | Función | Motivo |
|--------|---------|--------|
| 97-126 | `cobrar()` | No se crean PaymentIntents manuales; Stripe Invoice los genera |
| 71-80 | `crearSetupIntent()` | Checkout Session reemplaza el flujo de SetupIntent |

### En `cobrador.ts` (webhooks)
| Evento | Motivo de obsolescencia |
|--------|------------------------|
| `payment_intent.succeeded` (de cobro manual) | Los pagos llegan como `invoice.paid` |
| `payment_intent.payment_failed` | Los fallos llegan como `invoice.payment_failed` |

### En `packages/core/src/index.ts` (CobroConfig)
| Campo | Motivo |
|-------|--------|
| `intentos` (corte, fallos, ultimoError, requiereAccion, agotado) | Stripe maneja el estado de reintentos internamente |

### En `digsol-factory`
| Archivo | Qué | Motivo |
|---------|-----|--------|
| `TarjetaStripe.tsx` | Componente completo | Checkout Session captura tarjeta |
| `BillingModule.tsx` | Selector modo tarjeta/transferencia, polling, confirmación 3DS | Customer Portal reemplaza la gestión |

### Webhooks que dejan de llegar
- `setup_intent.succeeded` → ya no se crean SetupIntents
- `payment_intent.succeeded/failed` (de cobros manuales) → reemplazados por `invoice.paid/payment_failed`

---

## Qué se conserva

| Pieza | Por qué |
|-------|---------|
| `registrarPago()` | Sigue siendo el único camino a `pagadoHasta`; ahora alimentado por webhooks de Subscription |
| `registrarTransferencia()` | La transferencia con factura sigue siendo un modo de pago válido |
| `registrarReembolso()` | Los reembolsos siguen existiendo |
| `construirEvento()` (verificación de firma) | Todos los webhooks la usan |
| `cobrarCortes()` | Se conserva pero **salta** tenants con `stripeSubscriptionId` |
| Ledger completo (`Pago[]`) | Append-only, se sigue mostrando |
| `cotizar()` | Sirve para mostrar el desglose antes de suscribirse |
| `CargadorPrecios` | Sigue cargando `precios.json` para validación |
| `payment_method.detached` | Sigue siendo relevante |
| `refund.created/updated`, `charge.refunded` | Los reembolsos siguen existiendo |

---

## Lista de borrado (cuando Mau confirme que ningún tenant usa cobro viejo)

### Borrar en `cobrador.ts`
- [ ] `REINTENTOS_DIAS` (línea 23)
- [ ] `crearSetupIntent()` (líneas 233-247)
- [ ] `#cobrarCorte()` completo (líneas 291-351)
- [ ] `cobrarCortes()` — reemplazar por versión que solo corre transferencias o eliminar si ya no hay `modo=tarjeta` sin suscripción
- [ ] Rama de `payment_intent.succeeded` en `procesarWebhook()` (solo la de cobro manual)
- [ ] Rama de `payment_intent.payment_failed` en `procesarWebhook()`
- [ ] Todo el manejo de `intentos` (corte, fallos, agotado, requiereAccion)
- [ ] Avisos WhatsApp de reintentos agotados y tarjeta inválida (en `#cobrarCorte`)

### Borrar en `stripe.ts`
- [ ] `cobrar()` (líneas 97-126)
- [ ] `crearSetupIntent()` (líneas 71-80)
- [ ] `ResultadoCobro` interfaz (líneas 18-24)

### Borrar en `packages/core/src/index.ts`
- [ ] `intentos` en `CobroConfig` (todo el bloque)

### Borrar en `digsol-factory`
- [ ] `TarjetaStripe.tsx` completo
- [ ] En `BillingModule.tsx`: lógica de polling, confirmación 3DS, selector de modo tarjeta/transferencia
- [ ] `cauce.setupIntent()` en `lib/cauce.ts`

### Borrar en `app.ts`
- [ ] `POST /api/tenants/:t/cobro/setup-intent` (líneas 1192-1200)
- [ ] La lógica de `intentos` en `GET /api/tenants/:t/cobro`

### Borrar en tests
- [ ] Tests de `cobrarCortes` con PaymentIntent en `cobrador.test.ts`
- [ ] Tests de SetupIntent en `cobrador.test.ts` y `rutas.test.ts`
- [ ] Tests de retry schedule y 3DS en `cobrador.test.ts`

**Estimado del borrado:** ~400 líneas en el orquestador, ~200 en la plataforma,
~250 en tests. Media hora de trabajo limpio si se hace de una vez.

---

## Notas

- No hay lógica del camino viejo imposible de aislar. `cobrarCortes()` ya
  filtra por condiciones claras; añadir `&& !t.cobro?.stripeSubscriptionId`
  es limpio.
- `registrarPago()` no sabe ni le importa si el pago vino de un
  PaymentIntent manual o de un Invoice de Subscription: recibe fuente,
  referencia y monto. Es agnóstico al origen.
- La transferencia con factura (modo manual por admin) sigue intacta y no
  choca con Subscriptions.
