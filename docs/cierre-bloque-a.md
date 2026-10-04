# Cierre Bloque A — Suspensión + Energía

Fecha: 2026-10-03

## Commits por repo

### Utopia (`feature/bitrix-canal-abierto`)

| Commit | Mensaje |
|--------|---------|
| `fb29c2b` | fix(energia): elimina race condition en descuento de créditos y fail-open |
| `cbc7756` | feat(energia): medidor de energía — bolsa, créditos y degradación |
| `3f1c233` | feat(suspension): tenant suspendido queda en solo lectura sin capacidades |
| `59a19d5` | test(energia,motor): tests G1 cálculo de créditos y G2 fail-open |
| `34fefd0` | feat(suspension): aviso automático al contacto y campo avisoSuspensionEn (G5) |
| `92bdd0c` | fix(tipos): typecheck en verde: índices posiblemente undefined en adjuntos, webhook y app; costoUsd nulo en el agente; fixture de tenant en barrido.test |
| `eef9cc8` | docs: CLAUDE.md con las reglas del proyecto |
| `c1b4ac6` | refactor(test): quitar `as any` en estado suspendido (TenantEstado ya lo incluye) |

### digsol-factory (`trabajo/plataforma-sep2026`)

| Commit | Mensaje |
|--------|---------|
| `cca5545` | feat(suspension): banner de cuenta suspendida y campo suspendido en Yo |
| `262f7f2` | feat(suspension): lectura sin bloqueo, banner con forma y controles deshabilitados (G3+G4) |
| `e42589b` | docs: COMO-PROBAR.md y script de suspensión para verificación manual (G6) |
| `c6d3f75` | docs: CLAUDE.md con las reglas del proyecto |

## Qué se verificó

| Verificación | Resultado |
|--------------|-----------|
| `npm run typecheck` (Utopia, 4 workspaces) | 0 errores |
| `npm test` (Utopia) | 325 pasados, 17 omitidos, 0 fallos |
| `npx tsc --noEmit` (digsol-factory) | 0 errores |
| `npx vite build` (digsol-factory) | Compila OK |
| Tests de energía (G1): 5 tests en `energia.test.ts` | Pasan |
| Test fail-open (G2): 1 test en `motor.test.ts` | Pasa |
| Tests de suspensión (G5): 3 tests en `motor.test.ts` | Pasan |

## Qué NO se pudo verificar

| Escenario | Motivo |
|-----------|--------|
| Login real con Firebase Auth | Requiere sesión en el navegador con credenciales reales |
| Banner de suspensión visible en UI | Requiere levantar `npm run dev` con un tenant suspendido real; documentado en COMO-PROBAR.md con script |
| Envío de aviso WhatsApp al contacto | Requiere Evolution corriendo y un número real; el test verifica que `enviarInmediato` se invoca con el texto correcto |
| Descuento de créditos en Firestore real | Solo probado con repositorio en memoria; la lógica es la misma |
| Stripe (Bloque B) | No forma parte de este bloque |

## Riesgo de regresión

### Procesa
- **Riesgo bajo.** Procesa corre en Ohio (EC2 vieja, congelada). El código de
  suspensión y energía es nuevo y no toca rutas existentes de Procesa. El
  campo `estado` del tenant es nuevo (`TenantEstado = "activo" | "suspendido"`);
  tenants existentes no lo tienen seteado, y `tieneCapacidad()` trata ausencia
  como activo. Los tests de `planes.test.ts` verifican que un tenant sin campo
  `estado` conserva todas las capacidades.

### GeoSpectral
- **Riesgo bajo.** No es tenant del orquestador; la plataforma no tiene datos
  suyos. No hay impacto.

### We Build
- **Riesgo bajo.** Misma situación que Procesa: corre en Ohio. El código nuevo
  no altera el flujo de entrada existente. El motor solo ejecuta la rama de
  suspensión cuando `tenant.estado === "suspendido"`, que ningún tenant actual
  tiene.

### Riesgo general
- La adición de `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` en
  el typecheck ya fue resuelta en `92bdd0c`. No quedan errores.
- Los `as any` innecesarios en tests se limpiaron en `c1b4ac6`.
- El medidor de energía es fail-open: si Firestore falla al leer precios, el
  agente responde de todos modos y la falla se bitacorea. Probado en G2.

## Estado final

Bloque A **listo para revisión**. Ambas ramas compilan y pasan tests.
Espera compuerta de Mau para fusionar.
