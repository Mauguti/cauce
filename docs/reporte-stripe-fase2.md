# Reporte final — Sprint: cierre Bloque A + Stripe Fase 2

Fecha: 2026-10-04

---

## Resumen

El sprint tenía dos bloques con compuerta:

- **Bloque A** (suspensión + energía): ya construido en sesiones anteriores,
  cerrado con reporte en `cierre-bloque-a.md`.
- **Bloque B** (Stripe Fase 2): suscripciones, Checkout, Customer Portal,
  webhooks de ciclo de vida, documentación de pruebas y guía de revisión.

Ambos bloques están completos. Las dos ramas compilan y pasan tests.

---

## Commits por repo

### Utopia (`feature/bitrix-canal-abierto`) — Bloque B

| Commit | Mensaje | Item |
|--------|---------|------|
| `644b4ea` | docs(cobro): inventario Stripe fase 2 y lista de borrado del camino viejo | B1 |
| `07fb538` | feat(cobro): config de precios Stripe con 9 price IDs, validación y métodos de Subscription | B2 |
| `09e45c1` | feat(cobro): Checkout, suscripciones, webhooks y suspensión con bandera | B3+B4 |
| `a970a43` | docs: guía de revisión Stripe Fase 2 | B7 |

### digsol-factory (`trabajo/stripe-fase-2`) — Bloque B

| Commit | Mensaje | Item |
|--------|---------|------|
| `b3642de` | feat(billing): botones de suscripción y portal de Stripe en Billing | B5 |
| `81b8fb1` | docs: prueba e2e de Stripe en COMO-PROBAR.md | B6 |

### Utopia — Bloque A (construido en sesiones previas)

| Commit | Mensaje | Item |
|--------|---------|------|
| `fb29c2b` | fix(energia): elimina race condition en descuento de créditos y fail-open | — |
| `cbc7756` | feat(energia): medidor de energía — bolsa, créditos y degradación | — |
| `3f1c233` | feat(suspension): tenant suspendido queda en solo lectura sin capacidades | — |
| `59a19d5` | test(energia,motor): tests G1 cálculo de créditos y G2 fail-open | A1+A2 |
| `34fefd0` | feat(suspension): aviso automático al contacto y campo avisoSuspensionEn | A5 |
| `92bdd0c` | fix(tipos): typecheck en verde | A0 |
| `c1b4ac6` | refactor(test): quitar `as any` en estado suspendido | A-limpieza |
| `8acdc93` | docs: reporte de cierre Bloque A | A7 |

### digsol-factory — Bloque A (construido en sesiones previas)

| Commit | Mensaje | Item |
|--------|---------|------|
| `cca5545` | feat(suspension): banner de cuenta suspendida y campo suspendido en Yo | A4 |
| `262f7f2` | feat(suspension): lectura sin bloqueo, banner con forma y controles deshabilitados | A3+A4 |
| `e42589b` | docs: COMO-PROBAR.md y script de suspensión para verificación manual | A6 |

---

## Lo que se construyó vs. lo planeado

| Item | Planeado | Construido | Notas |
|------|----------|------------|-------|
| B1 Inventario | Documento con estado actual del Cobrador | Sí | `inventario-stripe-fase2.md` |
| B2 Productos y precios | Config de 9 price IDs con validación | Sí | `config-precios.ts` con tabla de montos y `cargarConfigPrecios()` |
| B3 Alta y suscripción | Checkout Session con trial 14 días | Sí | `iniciarSuscripcion()` en cobrador, ruta POST /cobro/checkout |
| B4 Webhooks → estado | 5 eventos nuevos de Subscription | Sí | `checkout.session.completed`, `invoice.paid/failed`, `subscription.updated/deleted` |
| B5 Portal del cliente | Botón en Billing que abre Customer Portal | Sí | `portalCliente()` en cobrador, GET /cobro/portal, botón en BillingModule |
| B6 Prueba e2e documentada | Ciclo completo con tarjetas de prueba | Sí | Secciones 7-12 en COMO-PROBAR.md |
| B7 Guía de revisión | Decisiones, flujos, riesgo | Sí | `revision-stripe-fase2.md` |

---

## Verificaciones

| Verificación | Resultado |
|--------------|-----------|
| `npm run typecheck` (Utopia, 4 workspaces) | 0 errores |
| `npm test` (Utopia, orchestrator) | 322 pasados, 17 omitidos, 0 fallos |
| `npm test` (Utopia, transports) | 20 pasados, 0 fallos |
| `npx tsc --noEmit` (digsol-factory) | 0 errores |
| `npx vite build` (digsol-factory) | Compila OK (1.69s) |

---

## Qué NO se pudo verificar y por qué

| Escenario | Motivo |
|-----------|--------|
| **Checkout completo en navegador** | Requiere `STRIPE_SECRET_KEY`, los 9 price IDs y `VITE_STRIPE_PUBLISHABLE_KEY` configurados. Los tests verifican la lógica con mocks. |
| **Webhooks reales de Stripe** | Requiere endpoint público y `STRIPE_WEBHOOK_SECRET`. Se puede probar en local con `stripe listen --forward-to`. Los tests cubren cada rama del switch. |
| **Customer Portal funcional** | Requiere un Customer ID real en Stripe. El test verifica que `portalCliente()` llama a `crearPortalSession()`. |
| **Reactivación automática tras pago** | Requiere `SUSPENSION_AUTOMATICA=true` y un `invoice.paid` real. El test verifica que el tenant pasa de suspendido a activo. |
| **Trial de 14 días → primer cobro** | Stripe no ofrece API para adelantar el reloj del trial. Se puede usar «End trial now» en el Dashboard de Stripe. |
| **Login real con Firebase Auth** | Requiere sesión en navegador con credenciales reales del proyecto. |
| **Envío de WhatsApp (aviso de impago)** | Requiere Evolution corriendo. El test verifica que `#aviso()` se invoca con el texto correcto. |

---

## Decisiones tomadas durante el sprint

1. **Convivencia Fase 1 + Fase 2**: `cobrarCortes()` salta tenants con
   `stripeSubscriptionId`. No se elimina el camino viejo; se deja obsoleto.

2. **Gracia de 5 días** (antes 10): `GRACIA_DIAS = 5`. Ningún cliente ha sido
   cobrado aún; no hay promesa previa que romper.

3. **Suspensión automática APAGADA por defecto**: `SUSPENSION_AUTOMATICA=false`.
   Con tenants en producción (Procesa, We Build), no se activa al fusionar. Mau
   decide cuándo encenderla.

4. **Trial de 14 días**: codificado en `iniciarSuscripcion()`. Checkout crea la
   suscripción con `trial_period_days: 14`.

5. **Ledger unificado**: `registrarPago()` es el mismo para PaymentIntents y
   facturas de Subscription. Idempotente por `(fuente, referencia)`.

---

## Riesgo de regresión

### Procesa

**Riesgo bajo.** No tiene `stripeSubscriptionId`. `cobrarCortes()` lo procesa
igual que antes. Los webhooks nuevos solo actúan si el evento trae un `tenantId`
que coincida. `SUSPENSION_AUTOMATICA=false` por defecto.

### We Build

**Riesgo bajo.** Misma situación que Procesa. El código nuevo no altera el flujo
de entrada existente.

### GeoSpectral

**Sin impacto.** No es tenant del orquestador.

### Cobro existente (Fase 1)

**Sin cambio.** SetupIntent, PaymentIntent directo y el calendario de reintentos
(0/+3/+7 días) siguen funcionando para tenants sin suscripción.

---

## Archivos documentación producidos

| Archivo | Repo | Contenido |
|---------|------|-----------|
| `COMO-PROBAR.md` (secciones 7-12) | digsol-factory | Prueba e2e Stripe con tarjetas de test |
| `docs/revision-stripe-fase2.md` | Utopia | Guía de revisión para Mau |
| `docs/inventario-stripe-fase2.md` | Utopia | Inventario del Cobrador antes de Fase 2 |
| `docs/reporte-stripe-fase2.md` | Utopia | Este reporte |

---

## Estado final

Sprint **completo**. Bloque A cerrado y reportado. Bloque B (B1-B7) construido,
documentado y verificado con tests. Ambas ramas compilan y pasan tests.

Espera revisión de Mau para fusionar.
