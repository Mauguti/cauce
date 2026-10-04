# Guía de revisión — Stripe Fase 2

Fecha: 2026-10-04

## Qué se construyó

Stripe Fase 2 añade **Subscriptions**, **Checkout** y **Customer Portal** al
cobrador existente (Fase 1: PaymentIntents con calendario propio). Las dos fases
conviven: `cobrarCortes()` salta tenants que ya tienen suscripción de Stripe.

### Commits

#### Utopia (`feature/bitrix-canal-abierto`)

| Commit | Mensaje | Bloque |
|--------|---------|--------|
| `644b4ea` | docs(cobro): inventario Stripe fase 2 y lista de borrado del camino viejo | B1 |
| `07fb538` | feat(cobro): config de precios Stripe con 9 price IDs, validación y métodos de Subscription | B2 |
| `09e45c1` | feat(cobro): Checkout, suscripciones, webhooks y suspensión con bandera | B3+B4 |

#### digsol-factory (`trabajo/stripe-fase-2`)

| Commit | Mensaje | Bloque |
|--------|---------|--------|
| `b3642de` | feat(billing): botones de suscripción y portal de Stripe en Billing | B5 |
| `81b8fb1` | docs: prueba e2e de Stripe en COMO-PROBAR.md | B6 |

---

## Archivos clave y qué hace cada uno

### Orquestador (Utopia)

| Archivo | Qué hace |
|---------|----------|
| `cobro/config-precios.ts` | Carga 9 price IDs de env vars. Valida montos contra tabla fija. |
| `cobro/stripe.ts` | Frontera con Stripe SDK: `crearCheckoutSession()`, `crearPortalSession()`, `obtenerSuscripcion()`. |
| `cobro/cobrador.ts` | `iniciarSuscripcion()`, `portalCliente()`, y las ramas de webhook nuevas en `procesarWebhook()`. |
| `app.ts` | Rutas `POST /cobro/checkout` y `GET /cobro/portal`. |

### Consola (digsol-factory)

| Archivo | Qué hace |
|---------|----------|
| `lib/cauce.ts` | `checkout()` y `portal()` — llamadas al orquestador. |
| `components/dashboard/BillingModule.tsx` | Botón «Suscribirse» (Checkout) y «Gestionar suscripción» (Portal). |

---

## Decisiones arquitectónicas

### 1. Convivencia Fase 1 + Fase 2

`cobrarCortes()` **salta** tenants con `stripeSubscriptionId`. Stripe maneja el
cobro recurrente con su propio dunning. El calendario propio (0/+3/+7 días) solo
aplica a tenants legacy con `modo=tarjeta` sin suscripción.

### 2. Gracia de 5 días (antes 10)

`GRACIA_DIAS = 5` en `cobrador.ts`. Ningún cliente ha sido cobrado aún, así que
no hay promesa previa que romper. Un solo lugar, una sola constante.

### 3. Suspensión automática APAGADA por defecto

`SUSPENSION_AUTOMATICA = false`. Con Procesa, GeoSpectral y We Build operando,
la suspensión automática no se enciende el día de la fusión. Se activa con la
variable de entorno `SUSPENSION_AUTOMATICA=true` cuando Mau lo decida.

Cuando está apagada:
- El webhook registra todo en bitácora y avisa por WhatsApp.
- El tenant **no** se suspende automáticamente.
- Mau suspende a mano con el script o desde Firestore.

Cuando está encendida:
- `customer.subscription.deleted` → `tenant.estado = "suspendido"`.
- `invoice.paid` después de suspensión → `tenant.estado = "activo"` (reactivación).

### 4. Trial de 14 días

Stripe Checkout crea la suscripción con `trial_period_days: 14`. Durante el
trial no se cobra. Al vencer, Stripe genera la primera factura.

### 5. Ledger unificado

`registrarPago()` es el único camino a `pagadoHasta`, tanto para PaymentIntents
como para facturas de Subscription. Idempotente por `(fuente, referencia)`.

---

## Configuración que Mau debe hacer en Stripe

1. **Crear 3 productos** (Básico, Estándar, Pro) con 3 precios cada uno.
   Montos con IVA (ver tabla en COMO-PROBAR.md sección 7).

2. **Copiar los 9 `price_...`** a las variables de entorno del orquestador.

3. **Configurar Customer Portal** (Settings → Billing → Customer Portal):
   - Permitir cancelar suscripción.
   - Permitir cambiar método de pago.
   - No permitir cambiar de plan.

4. **Configurar webhook** al endpoint `/stripe/webhook`:
   - Agregar los eventos de Subscription: `checkout.session.completed`,
     `invoice.paid`, `invoice.payment_failed`,
     `customer.subscription.updated`, `customer.subscription.deleted`.
   - Los eventos de Fase 1 ya deberían estar configurados.

5. **Decidir** cuándo encender `SUSPENSION_AUTOMATICA=true`.

---

## Flujo por pantalla

### Suscribirse (nuevo)

```
Consola Billing → «Suscribirse»
  → POST /api/tenants/:t/cobro/checkout (plan, periodo, URLs)
  → Cobrador.iniciarSuscripcion()
    → asegurarCliente() (crea Customer si no existe)
    → stripe.crearCheckoutSession() (con trial 14 días)
  → Redirect a Stripe Checkout
  → Pago exitoso → Stripe envía checkout.session.completed
    → Webhook vincula subscriptionId al tenant
  → Redirect a consola con ?checkout=ok
```

### Gestionar suscripción

```
Consola Billing → «Gestionar suscripción»
  → GET /api/tenants/:t/cobro/portal?returnUrl=...
  → Cobrador.portalCliente()
    → stripe.crearPortalSession()
  → Redirect a Stripe Customer Portal
  → Cliente cambia tarjeta / cancela / ve recibos
  → Vuelta a la consola
```

### Cobro recurrente (automático por Stripe)

```
Stripe genera factura al vencer periodo
  → Cobra con la tarjeta guardada
  → invoice.paid → registrarPago() → pagadoHasta avanza
  ó
  → invoice.payment_failed → gracia 5 días, aviso WhatsApp
  → Si subscription.deleted → suspensión (si bandera encendida)
```

---

## Qué revisar en código

1. **`config-precios.ts`**: que los montos de la tabla coincidan con lo que
   configures en Stripe Dashboard.
2. **`cobrador.ts:299-323`** (`iniciarSuscripcion`): lógica de Checkout.
3. **`cobrador.ts:522-630`** (webhooks de Subscription): cada rama del switch.
4. **`cobrador.ts:37`** (`SUSPENSION_AUTOMATICA`): la bandera y su efecto.
5. **`BillingModule.tsx:136-161`**: botones de la consola.
6. **`cauce.ts:415-427`**: URLs de success/cancel del Checkout.

---

## Riesgo de regresión

### Procesa y We Build

**Riesgo bajo.** No tienen `stripeSubscriptionId`. `cobrarCortes()` los procesa
igual que antes. Los webhooks nuevos solo actúan si el evento trae un
`tenantId` que coincida. `SUSPENSION_AUTOMATICA=false` por defecto: nadie se
suspende automáticamente hasta que Mau lo encienda.

### GeoSpectral

**Sin impacto.** No es tenant del orquestador.

### Cobro existente (Fase 1)

**Sin cambio.** SetupIntent, PaymentIntent directo y el calendario de reintentos
siguen funcionando para tenants sin suscripción. El ledger es el mismo.
