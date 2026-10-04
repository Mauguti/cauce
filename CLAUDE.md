# Cauce: orquestador de Digsol Factory

Motor de WhatsApp de Digsol Factory: Node + Express + Firestore (base con
nombre `factory`) + Evolution en Docker. Corre en una EC2 de México
(`api.factory.digsol.com.mx`, systemd `factory`, variables en
`/etc/factory.env`). El front del producto NO está aquí: es el repo
`~/digsol-factory`. `apps/console` es la consola vieja de Cauce y está
congelada: no recibe trabajo de producto.

Rama de trabajo: `feature/bitrix-canal-abierto`. Dueño del producto: Mau.

## Reglas duras

1. **Nunca despliegues.** Ni `scripts/deploy.sh`, ni SSH a la EC2, ni
   `firebase deploy`. Mau despliega. Tú preparas y verificas en local.
2. **Secretos fuera del repo y del chat.** Llaves, tokens, client secrets
   y contenido de `/etc/factory.env` nunca se escriben en archivos
   versionados ni se piden o repiten en la conversación. Mau los captura
   él mismo. En bitácora, teléfonos siempre con `enmascararTelefono`.
3. **Ohio no se toca.** La EC2 vieja de Cauce (clientes Procesa y We
   Build) está congelada. Nada de este repo se prueba contra ella.
4. **Compuertas por código de salida antes de cada commit**, las dos:
   `npm run typecheck` y `npm test` deben salir con 0. Vitest no corre
   `tsc`: pruebas en verde con tipos rotos NO cuenta. No hagas commit con
   una compuerta en rojo ni la saltes.
5. **Un commit por pieza**, mensaje en español con prefijo
   (`feat(x):`, `fix(x):`, `docs(x):`). Mensajes largos con
   `git commit -F archivo` (zsh expande paréntesis y asteriscos).
   No toques cambios locales ajenos (`MIGRACION-PLAN.md`, `Claude outputs/`).
6. **Reporta solo lo verificado** y di qué no pudiste verificar. "Las
   pruebas pasan" no es "funciona en producción".
7. **Nada de datos de demostración** donde viven datos reales. Lo que no
   existe se rotula "Próximamente" o se deshabilita.
8. **Sin LLM propio alojado.** Proveedor de modelo por tenant
   (`agentes/proveedor.ts`, hoy Anthropic).
9. Si algo visible para el cliente cambia de comportamiento, pregunta
   antes. Las decisiones de producto son de Mau.

## Comandos

```
npm run typecheck          # los cuatro workspaces; debe salir 0
npm test                   # suite completa; debe salir 0
npx vitest run apps/orchestrator/src/<ruta>   # una parte
npm run dev:orchestrator   # local, repositorio en memoria
```

TypeScript estricto con `exactOptionalPropertyTypes` y
`noUncheckedIndexedAccess`: `arr[i]` puede ser `undefined`, y un campo
opcional no acepta `undefined` explícito (usa spreads condicionales
`...(x ? { x } : {})`).

## Mapa

- `packages/core/src/index.ts`: tipos compartidos, planes y capacidades,
  `rutas` de Firestore, cálculo de cobro.
- `apps/orchestrator/src/app.ts`: todas las rutas HTTP. `index.ts`: wiring
  y jobs. `store.ts` (interfaz + memoria) y `store-firestore.ts`: toda
  escritura pasa por el repositorio; ambas implementaciones se mantienen
  a la par.
- `entrada/motor.ts`: cada mensaje entrante (anti-bucle, cortacircuitos,
  disparadores, agente). `agentes/`: Santiago (ventas), Susana (citas),
  medidor de consumo, trazabilidad. `cobro/`: Stripe y ledger de pagos.
  `bitrix/`, `monday/`, `google/`: conectores.
- `log.ts`: bitácora logfmt con `registrar` / `registrarError`. Toda
  decisión que apaga o cambia algo deja una línea con el motivo.

## Invariantes que no se rompen

- `pagadoHasta` solo lo escribe `Cobrador.registrarPago`; el ledger
  `tenants/{t}/pagos` es append-only (un reembolso es una fila negativa).
- Los precios no viven aquí: se leen de `precios.json` de la plataforma
  (`CAUCE_PRECIOS_URL`). Sin foto de precios no se cobra.
- Las conversaciones solo se escriben fusionando (nunca reconstruyendo el
  documento): ya se perdieron campos dos veces por eso.
- Webhooks externos (Stripe, Bitrix, monday): nada del cuerpo se cree
  antes de verificar firma o token; el rechazo se registra con motivo.
- La suspensión de un tenant es manual. Un cobro fallido solo avisa.
- Susana: confirmación en dos pasos, cede ante un empalme, zona horaria
  del calendario, nada de salud. Ver `docs/susana.md`.

## Documentos de referencia

`docs/deploy.md` (variables y despliegue; las partes sobre la consola de
Cauce y `migrar-planes` son históricas), `docs/stripe.md`,
`docs/susana.md`, `docs/agentes.md`, `docs/catalogo-agentes.md`,
`docs/vencido-y-suspension.md`, `docs/alta-cliente-*.md`. El tablero de
tareas vive en Notion ("Digsol Factory · Lanzamiento").
