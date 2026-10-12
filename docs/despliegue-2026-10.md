# Despliegue de octubre 2026: cuatro semanas de ramas a producción

Preparado el 12-oct-2026 y **rehecho el mismo día sobre las puntas
reales** (v2). **No ejecutado.** Lo ejecuta Mau con autorización
explícita, paso por paso, con la reversa leída antes.

## 0. Qué cambia respecto del plan anterior (v1, contra `*stripe-fase-2`)

| | v1 | v2 (este) |
|---|---|---|
| Punta del orquestador | `fae69dd` (`feature/stripe-fase-2`) | **`89c740a`** (`feature/monday-webhook-endurecido`), 29 commits sobre producción |
| Punta de la plataforma | `fb3d415` (`trabajo/stripe-fase-2`) | **`ce883cb`** (`trabajo/monday-webhook-endurecido`) |
| Piezas nuevas que entran | — | Selector de tableros de monday (buscador, subelementos anidados, ID directo, carga por páginas); **webhook de monday endurecido**: item solo del tablero configurado, deduplicación de 10 min por item y plantilla, rechazos en bitácora con IP; campo de firma renombrado; sonda `scripts/monday-sonda.mjs` |
| Variables nuevas | `GA4_*` ya estaban listadas | Ninguna más. `STRIPE_*`, `GOOGLE_*`, `CAUCE_PRECIOS_URL`, `GA4_*` siguen fuera de este corte |
| Rutas nuevas desde v1 | — | `POST /conectores/monday/boards`, `POST /conectores/monday/board` (ambas con auth de tenant) |
| **Comportamiento que cambia para un cliente con monday ya conectado** | — | (1) Un item de un tablero distinto al configurado **ya no dispara**: queda `monday.rechazado motivo=item_fuera_del_tablero` y el fallo se ve en Salientes. (2) El mismo item no vuelve a disparar la misma plantilla dentro de 10 min (`motivo=duplicado`, solo bitácora). (3) `getItem` pide además `board { id }`: una llamada igual, un campo más. Ver §1b. |
| Verificación añadida | — | Paso 2 · 9 y 10 (monday) y Paso 3 · 7 |
| Reversa | igual | igual: `ee67555` sigue siendo el punto de vuelta; las ramas intermedias no se despliegan |

Las cuatro ramas de cada repo son una sola línea: `main` → `*stripe-fase-2`
→ `*monday-selector-tableros` → `*monday-webhook-endurecido`, cada una
ancestro de la siguiente (verificado con `merge-base`). Fusionar la punta
trae todo; no hay nada que elegir ni conflictos posibles.

## Qué hay y qué va

| | Producción hoy | Va a producción |
|---|---|---|
| Orquestador (México, `api.factory.digsol.com.mx`, systemd `factory`) | `ee67555` (14-sep) | **`89c740a`** (`feature/monday-webhook-endurecido`) |
| Plataforma (Firebase Hosting `digsol-fabrica-de-empleados`, hoy en `digsol-fabrica-de-empleados.web.app`) | build sin `precios.json` (anterior al 14-sep) | **`ce883cb`** (`trabajo/monday-webhook-endurecido`) |

Las ramas `*monday-webhook-endurecido` son las puntas reales y contienen
por completo a `*monday-selector-tableros`, `*stripe-fase-2`,
`feature/bitrix-canal-abierto` y `trabajo/plataforma-sep2026`. Todas
empujadas a origin (12-oct), local igual a remoto. `main` de cada repo es
ancestro de su punta: la fusión es **fast-forward, sin conflictos
posibles**.

Decisión ya tomada: se despliega completo, no a medias. GeoSpectral se
está instalando esta semana contra México; un bucle entre líneas en un
cliente vivo pesa más que el riesgo del despliegue. Lo que sí se gradúa
por **variables de entorno**, no por código: lo que no tenga su variable
arranca apagado y lo dice en el arranque.

**`factory.digsol.com.mx` no está caída: no existe.** El dominio no tiene
registro DNS (`dig` no devuelve A ni CNAME; `curl` no resuelve desde la
misma red que sí llega a `api.factory.digsol.com.mx`). La plataforma vive
en `digsol-fabrica-de-empleados.web.app`. Es la tarea del tablero "Publicar
la plataforma en Firebase Hosting con dominio propio", sin empezar. Esto
decide `CAUCE_PRECIOS_URL` y `CAUCE_PLATAFORMA_URL` (§3c).

## 1. Comprobaciones previas

### a) Ningún tenant con `estado: "suspendido"` por accidente

Con el código nuevo, `estado === "suspendido"` deja al tenant sin
capacidades: no envía, no contesta, solo lee. Hoy ese valor no lo escribe
nadie en producción (`ee67555` no lo conoce), pero el campo existe desde
siempre en el documento. Comprobar antes, en la EC2 (solo lectura):

```bash
cd /opt/factory && GOOGLE_APPLICATION_CREDENTIALS=/etc/factory-firestore.json \
  CAUCE_FIRESTORE_DB=factory NODE_PATH=/opt/factory/node_modules \
  node scripts/tenants-estado.mjs
```

Imprime id, nombre, plan, estado, pagadoHasta, agente y líneas de cada
tenant y **sale con código 2 si hay algún suspendido**. Si hay uno y no es
intencional, se corrige el campo a `activo` antes del despliegue. Desde
esta Mac no se pudo correr: la cuenta de gcloud local no tiene permiso en
el proyecto.

De paso, ese reporte dice el plan de Procesa y GeoSpectral, que decide
cuánto de §2 les aplica.

### b) Riesgo de regresión sobre Procesa y GeoSpectral, pieza por pieza

Las dos son Estándar con canal abierto de Bitrix (sin agentes, salvo que
el reporte de (a) diga otra cosa). Solo cuenta lo que toca el camino del
mensaje entrante y saliente; lo demás es ruta nueva que nadie llama.

| Pieza | Qué cambia en su camino | Qué puede romperse | Cómo se nota |
|---|---|---|---|
| **Entrantes con adjunto** (`webhook.ts`) | Antes un audio, imagen, documento o sticker se descartaba. Ahora entra como mensaje con cuerpo vacío o con el caption. | (1) En el timeline de Bitrix aparece una línea `📥 ` vacía por cada foto o sticker sin texto. (2) Un disparador de primer contacto puede contestar a un sticker. (3) En el canal abierto, el mensaje llega al operador sin texto. El archivo **no** se guarda: el almacén de adjuntos no está conectado en `index.ts`, y aunque lo estuviera, la descarga va en `try/catch`. | Bitácora `entrante.guardado` con cuerpo vacío; líneas `📥 ` en Bitrix; `openlines.adjunto_no_soportado`. Riesgo medio de **ruido**, no de caída. Si molesta, se filtra en caliente (un `if` en `motor.ts`); no es reversa. |
| **Cortacircuitos y filtro de línea propia** | Ya están en `ee67555`. No cambian. | Nada nuevo. | — |
| **Ventana humana** | Sin cambio funcional desde `ee67555`. | Nada nuevo. | — |
| **Suspensión** (`motor.ts`, `core`) | Rama nueva solo si `estado === "suspendido"`. | Si (a) está limpio, no se ejecuta. | `entrada.respuesta … suspendido` nunca debe aparecer para Procesa ni GeoSpectral. |
| **Energía** (`motor.ts`) | Solo con capacidad `agentes` (Pro) y con `CAUCE_PRECIOS_URL`. | No aplica a Estándar. Sí aplica a **Digsol** (Pro, Santiago): si el gasto del mes ya rebasó la bolsa de $200 y no hay créditos, Santiago deja de contestar y manda el mensaje de energía agotada. | `energia.agotada` en bitácora. Mitigación: desplegar primero **sin** `CAUCE_PRECIOS_URL` (fail-open, confirmado en código) y encenderla después de leer el consumo de octubre en Billing. |
| **Webhook de monday endurecido** (`monday/conector.ts`, `app.ts`) | Rechaza items de otro tablero y duplicados en 10 min; `getItem` pide `board { id }`. Procesa y GeoSpectral usan Bitrix, no monday: no les toca. Al tenant que sí use monday (hoy, según el reporte de §1a) le aplica. | Una automatización pegada en un tablero distinto al configurado deja de disparar; un estado que cambia dos veces en 10 min manda un solo mensaje. | `monday.rechazado` con `motivo=` e `ip=`; en Salientes, "item fuera del tablero". Es el comportamiento buscado; si un cliente dependía de disparar desde otro tablero, se reconfigura el conector a ese tablero. |
| **Selector de tableros** (`/conectores/monday/boards`, `/board`) | Rutas nuevas; `probar` devuelve además `pagina` y `hayMas`. | Nada en el camino del mensaje. | — |
| **Bitrix `ONAPPUNINSTALL`** (`openlines`) | Evento nuevo: al desinstalar la app del portal, borra los tokens del tenant. | Un evento falso borraría tokens; valida `application_token` y registra el rechazo. Procesa no tiene el handler registrado hasta reinstalar. | `openlines.desinstalada` o `openlines.desinstalacion_rechazada`. Riesgo bajo. |
| **Salientes, cola, confirmaciones** | Sin cambios. | — | — |
| **`/health`** | Agrega `stripe` y `google`. | Monitores que comparen el JSON completo. | — |
| **Admin `POST /pago`** | Cambia de contrato: ya no acepta `pagadoHasta`, pide `folio`, `montoMxn`, `periodo`. | El procedimiento manual con el que Mau registraba pagos deja de funcionar tal cual. | 400 con mensaje claro. Documentado en `docs/stripe.md`. |
| **Jobs nuevos** (`cobrarCortes` cada hora) | Lee todos los tenants cada hora. | Sin Stripe es un no-op. Costo de lecturas despreciable. | `cobro.*` ausente = normal sin Stripe. |
| **Firestore** | Colecciones nuevas (`directorio`, `pagos`, `reservas`, `conectores/google`) y campos nuevos en `tenants` y `conversaciones`. Sin índices compuestos nuevos. | Nada en Procesa ni GeoSpectral hasta que alguien las use. | — |

**Lo que sí es un bug encontrado al revisar** (no bloquea porque Stripe
va apagado, pero debe arreglarse antes de encenderlo): en `invoice.paid`
el periodo se lee de `lines[0].metadata.periodo`, y `subscription_data.
metadata` solo lleva `tenantId`. Una factura semestral o anual registraría
**1 mes** de cobertura. Se corrige en la Parte 2 de esta sesión al
agregar `plan` y `periodo` a la metadata de la suscripción.

### c) Variables de entorno que el código pide y hoy pueden faltar

Nuevas respecto a `ee67555` (el orquestador arranca sin todas; lo que
falta queda apagado y lo dice en el arranque):

| Variable | Si falta | Para este despliegue |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Cobro con tarjeta apagado; `/health` `stripe: null` | **No poner todavía.** Primero la corrida en modo test (docs/stripe.md). |
| `STRIPE_PRICE_{BASICO,ESTANDAR,PRO}_{MENSUAL,SEMESTRAL,ANUAL}` (9) | Checkout responde 503 "precios no configurados"; `config.precios_stripe_incompleta` | No todavía. |
| `CAUCE_PRECIOS_URL` | No se cotiza, no se cobra, **energía en fail-open** | **No poner en este corte** (ver energía en §1b). Cuando se ponga, apunta al `precios.json` de la plataforma publicada: hoy `https://digsol-fabrica-de-empleados.web.app/precios.json`, no `factory.digsol.com.mx`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar y Susana apagados; `/health` `google: false` | Cuando exista el proyecto en Google Cloud. |
| `CAUCE_PLATAFORMA_URL` | Usa el primer origen de `CAUCE_CORS_ORIGENES` | Poner `https://digsol-fabrica-de-empleados.web.app` cuando entre Google. |
| `CAUCE_ADJUNTOS_DIR` | Default `/var/cauce/adjuntos`; el almacén no está conectado, así que no se usa | Nada. |
| `SUSPENSION_AUTOMATICA` | `false`: una suscripción cancelada en Stripe NO suspende; solo bitácora | **Dejar sin definir.** La suspensión sigue a mano. |
| `GA4_MEASUREMENT_ID`, `GA4_API_SECRET` (Parte 2) | Medición de conversiones apagada | Cuando exista la propiedad de GA4. |

Ya existentes que deben seguir: `CAUCE_URL_PUBLICA`, `CAUCE_CORS_ORIGENES`
(debe incluir `https://digsol-fabrica-de-empleados.web.app`),
`CAUCE_ADMIN_KEY`, `CAUCE_CRYPTO_KEY`, `ANTHROPIC_API_KEY`,
`CAUCE_FIRESTORE_DB=factory`, `GOOGLE_APPLICATION_CREDENTIALS`,
`CAUCE_AVISOS_WHATSAPP`, `CAUCE_USD_MXN`.

Comprobación en la EC2, sin mostrar valores:

```bash
for v in CAUCE_URL_PUBLICA CAUCE_CORS_ORIGENES CAUCE_ADMIN_KEY CAUCE_CRYPTO_KEY ANTHROPIC_API_KEY CAUCE_FIRESTORE_DB GOOGLE_APPLICATION_CREDENTIALS CAUCE_AVISOS_WHATSAPP STRIPE_SECRET_KEY CAUCE_PRECIOS_URL GOOGLE_CLIENT_ID SUSPENSION_AUTOMATICA; do printf '%-32s %s\n' "$v" "$(sudo grep -qE "^$v=." /etc/factory.env && echo presente || echo FALTA)"; done
```

Y después del arranque, lo que el propio orquestador dice que le falta:

```bash
journalctl -u factory --since "5 min ago" -o cat | grep -E "sin definir|deshabilitad"
```

## 2. Fusión

Las dos ramas se fusionan a `main` por fast-forward **después** de que
producción las haya corrido al menos un día sin incidente. Así `main`
sigue siendo "lo que está en producción" y la reversa es un checkout.

```bash
# Utopia (trae stripe-fase-2 y selector por ser ancestros)
git checkout main && git merge --ff-only feature/monday-webhook-endurecido && git push origin main
# digsol-factory
git checkout main && git merge --ff-only trabajo/monday-webhook-endurecido && git push origin main
```

Después de fusionar, las ramas intermedias (`*stripe-fase-2`,
`*monday-selector-tableros`, `feature/bitrix-canal-abierto`,
`trabajo/plataforma-sep2026`) quedan contenidas en `main` y se pueden
borrar; no antes.

Si `--ff-only` falla, alguien tocó `main` después del 12-oct: parar y revisar.

## 3. Orden de despliegue

**Orquestador primero, plataforma después.** La plataforma nueva llama
rutas que el orquestador viejo no tiene (`/cobro`, `/agentes/conversaciones`,
`/google`, `/directorio`); al revés, la plataforma vieja contra el
orquestador nuevo funciona sin problema.

### Paso 1 · Comprobaciones (§1a y §1c). Sin verde, no se sigue.

### Paso 2 · Orquestador → `89c740a`

`scripts/deploy.sh` es de la consola de Cauce (servicio `cauce`, proyecto
`cauce-consola`): **no se usa**. En la EC2 de México, con el commit
exacto (no la rama):

```bash
cd /opt/factory && git fetch --quiet origin && git checkout --quiet 89c740a && npm ci && sudo systemctl restart factory
```

Confirmar el directorio y el servicio antes con `systemctl cat factory | grep -E 'WorkingDirectory|ExecStart|EnvironmentFile'`; `docs/deploy.md` todavía dice `/opt/cauce` en partes viejas.

Verificación, en orden, cada una con su evidencia:

| # | Qué | Evidencia |
|---|---|---|
| 1 | Servicio arriba | `systemctl is-active factory` → `active` |
| 2 | Versión | `curl -s https://api.factory.digsol.com.mx/health` → `{"ok":true,"version":"89c740a","stripe":null,"google":false}` |
| 3 | Repositorio correcto | `journalctl -u factory --since "5 min ago" -o cat \| grep repositorio` → base `factory` |
| 4 | Lo apagado es lo esperado | mismo journal, `grep -E "sin definir\|deshabilitad"`: Stripe, precios, Google. **Nada más.** |
| 5 | Sesiones rehidratadas | `webhook.alcance resultado=ok` y las líneas de Procesa, GeoSpectral y Digsol en `connected` en Sesiones de la plataforma |
| 6 | Entrante real | Mau escribe a la línea de Digsol desde su celular: `entrante.guardado` y `entrada.respuesta` en bitácora; Santiago contesta (sin `CAUCE_PRECIOS_URL` no hay medidor que lo frene) |
| 7 | Canal abierto de Procesa | Un mensaje a una línea de Procesa aparece en su Contact Center y la respuesta del operador llega al WhatsApp: `openlines.entrante` y `openlines.operador` |
| 8 | Trazabilidad | `GET /api/tenants/<digsol>/agentes/conversaciones` responde 200 (con token) |
| 9 | Webhook de monday sigue vivo | Si hay un tenant con monday: disparar una automatización real sobre un item del tablero configurado → `entrada.monday` y `envio.enviado`; **sin** líneas `monday.rechazado` para ese item |
| 10 | Endurecimiento | POST a `/webhooks/monday/<tenant>/<plantilla>` con `{"event":{"pulseId":"<item>","boardId":"999"}}` → 200 a monday y `monday.rechazado motivo=item_fuera_del_tablero ip=<tu ip>` en el journal; repetir el disparo legítimo del punto 9 dentro de 10 min → `motivo=duplicado` |

Si 1–5 fallan: reversa del orquestador (§4) de inmediato. Si 6–10 fallan:
diagnosticar con el journal antes de revertir; nada de eso afecta a
Procesa ni GeoSpectral.

### Paso 3 · Plataforma → `ce883cb`

```bash
cd ~/digsol-factory && git checkout ce883cb && npx tsc --noEmit && npx vite build && firebase deploy --only hosting --project digsol-fabrica-de-empleados
```

Con `VITE_CAUCE_API=https://api.factory.digsol.com.mx` en `.env.local`
(el build falla a propósito si falta). `VITE_STRIPE_PUBLISHABLE_KEY` y
`VITE_GA4_MEASUREMENT_ID` vacías en este corte.

Verificación:

| # | Qué | Evidencia |
|---|---|---|
| 1 | Build publicado | `curl -s https://digsol-fabrica-de-empleados.web.app/precios.json` devuelve JSON con `"version": "ce883cb"` (hoy devuelve el index.html: es el build viejo) |
| 2 | Login y Sesiones | Entrar con tu cuenta; líneas con punto verde |
| 3 | Billing | Muestra "Cobro con tarjeta · Próximamente" y "Pagar por transferencia"; sin botones rotos |
| 4 | Trazabilidad → Agentes | Lista conversaciones de Santiago de octubre con costo en pesos; abre un hilo |
| 5 | Integraciones | Google Calendar dice "Próximamente en este entorno" (sin credenciales) |
| 6 | Banner de suspensión | **No** aparece en tu cuenta |
| 7 | Selector de monday | Integraciones → monday → pegar token → Probar: lista con buscador, subelementos bajo su padre (o en el grupo "Subelementos" si `boardIds` no llega), campo de ID; pegar el ID de un tablero privado ajeno → mensaje que dice "puede ser privado… el ID no salta permisos" |

### Paso 4 · Un día después

Fusión a `main` (§2). Cerrar en el tablero las tareas ya construidas
que siguen en "Not started" (Panel de Sesiones, Trazabilidad real, Bots,
Directorio, "Próximamente", Susana).

### Paso 5 · Encendidos posteriores, cada uno con su propia verificación

1. `CAUCE_PRECIOS_URL` → `precios.leidos` en bitácora; Billing cotiza el
   próximo cobro; **leer `energia.*` de Digsol las primeras horas**.
2. Stripe en modo test (docs/stripe.md, corrida completa) → solo después
   llaves live.
3. Google Cloud → `google: true` → Susana desde el celular de Mau.

## 4. Reversa, escrita antes

**Regla: datos antes que código, y nunca al revés.** El código viejo no
conoce los campos nuevos pero los ignora (todos opcionales), así que no
hay migración de datos que revertir en este corte. Las colecciones nuevas
se quedan; no estorban.

### Orquestador → `ee67555`

```bash
cd /opt/factory && git checkout --quiet ee67555 && npm ci && sudo systemctl restart factory
curl -s https://api.factory.digsol.com.mx/health     # → "version":"ee67555"
journalctl -u factory -n 30 --no-pager -o cat
```

Tiempo: 2 minutos. Qué se pierde al revertir: nada de Procesa ni
GeoSpectral (su camino es el mismo que hoy). Se pierden las rutas nuevas
(la plataforma nueva mostrará "Próximamente"/errores en Billing y
Trazabilidad → Agentes hasta que se revierta también o se vuelva a subir).

Variables agregadas en `/etc/factory.env` pueden quedarse: `ee67555` las
ignora.

### Plataforma → build anterior

Firebase Hosting guarda versiones: en la consola de Firebase → Hosting →
historial → "Revertir" a la versión previa (un clic, sin build). O por
código:

```bash
cd ~/digsol-factory && git checkout <COMMIT_ANTERIOR> && npx vite build && firebase deploy --only hosting --project digsol-fabrica-de-empleados
```

### Orden si hay que revertir todo

1. Plataforma (Hosting → versión previa).
2. Orquestador a `ee67555`.
3. Nada que tocar en Firestore.

### Lo que NO se revierte con esto

Un tenant que haya quedado `suspendido` o con `creditosMxn` escrito por
el código nuevo conserva el campo; `ee67555` lo ignora. Si hubo cobros de
Stripe (no en este corte: va apagado), el ledger `pagos` se queda y es la
verdad.

## 5. Fuera de este despliegue (anotado, no tocado)

Dominio `factory.digsol.com.mx` (no existe), SEO, pre-renderizado, retiro
del nombre "Cauce" (`scripts/deploy.sh`, `/opt/cauce` en docs), adjuntos
del lado de Bitrix (el almacén no está conectado), módulo de documentos.

Anotado al rehacer el plan, sin arreglar:
- `docs/deploy.md` §2.3 y §2.7 siguen diciendo `/opt/cauce`, `/etc/cauce.env`
  y `cauce-consola`; México es `/opt/factory`, `/etc/factory.env`, `factory`.
- La plataforma publicada en `web.app` es anterior al 14-sep (sin
  `precios.json`); cualquier verificación de Billing o Trazabilidad contra
  producción espera al Paso 3.
- Vite avisa `%VITE_GA4_MEASUREMENT_ID% is not defined` en cada build; es
  cosmético (el HTML sale con `var id = ""`).
- La sonda `scripts/monday-sonda.mjs` y las tres verificaciones del
  selector contra monday real siguen pendientes de un token de prueba y de
  un tablero privado creado por otro usuario.
