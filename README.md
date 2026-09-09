# Digsol Factory

La fábrica de empleados digitales. Capa de mensajería para CRMs: conecta
el CRM que la empresa ya usa con el número de WhatsApp que sus clientes ya
tienen guardado. El CRM dispara el mensaje, Digsol Factory lo envía desde
el número propio del cliente, y la respuesta vuelve escrita al registro
que la originó.

> Nota: el nombre interno del proyecto y de sus paquetes sigue siendo
> `cauce` (paquetes `@cauce/*`, variables `CAUCE_*`, nombre de instancia
> `cauce-{tenant}-{instance}`, dominio `cauce.digsol.com.mx`). Esos
> identificadores NO se renombran porque están registrados en producción
> (contenedores, volúmenes, dispositivos vinculados, automatizaciones de
> los clientes). Ver `docs/renombrado-digsol-factory.md`.

## Estructura

| Ruta | Qué es |
|---|---|
| `apps/orchestrator` | Servicio Node (Express). Único expuesto a internet. |
| `apps/console` | Frontend React. Hoy: lista de instancias del tenant. |
| `packages/core` | Tipos y modelo de datos compartidos. |
| `packages/transports` | Interfaz `MessageTransport` + implementaciones. |
| `packages/ui` | Tokens del sistema visual y componentes base. |
| `docs/adr` | Decisiones de arquitectura. |

**Desplegado:** consola en https://cauce-consola.web.app (Firebase
Hosting). El orquestador corre en EC2 detrás de Caddy —
procedimiento en [docs/deploy.md](docs/deploy.md).

Las decisiones que gobiernan todo el código están en
[docs/adr/0001](docs/adr/0001-transporte-intercambiable.md)
(transporte intercambiable),
[docs/adr/0002](docs/adr/0002-multitenancy.md) (multitenancy) y
[docs/adr/0003](docs/adr/0003-socket-docker.md) (acceso al socket de
Docker y red de contenedores).

Persistencia en Firestore (`RepositorioFirestore`); en memoria si no hay
credenciales. Conector de monday en `apps/orchestrator/src/monday/`
(ver abajo). Login de usuarios: pendiente, diseñado en
[docs/auth-usuarios.md](docs/auth-usuarios.md).

## Disparadores de entrada

Un mensaje entrante puede disparar una respuesta automática. Cada
conversación (par instancia+teléfono) tiene identidad estable en
Firestore: el primer contacto, el último entrante y el vínculo con el
item de monday viven ahí, así que sobreviven a que la sesión se
desconecte y reconecte.

Cuatro condiciones, evaluadas por `prioridad` ascendente; **la primera
que coincide gana**: `primer_contacto`, `palabra_clave` (contiene/igual),
`cualquiera`, `fuera_horario` (horario laboral por tz). Las respuestas
salen por un **carril inmediato sin rate limiting** — responder dentro
de una conversación activa es seguro y debe ser instantáneo; el
espaciado de 45-65s de la cola solo protege los envíos proactivos.

Config por tenant (reemplaza la lista entera):

```bash
curl -X PUT https://cauce.digsol.com.mx/api/tenants/demo/disparadores \
  -H "x-api-key: $CAUCE_API_KEY" -H "content-type: application/json" \
  -d '[{"id":"bienvenida","prioridad":1,"tipo":"primer_contacto","activo":true,
        "respuesta":"¡Hola! Gracias por escribir, te atendemos enseguida."},
       {"id":"ausencia","prioridad":5,"tipo":"fuera_horario","activo":true,
        "respuesta":"Estamos fuera de horario; te respondemos mañana.",
        "horario":{"tz":"America/Mexico_City","dias":[1,2,3,4,5],
                   "desde":"09:00","hasta":"18:00"}}]'
```

## Conector de monday

Un item de monday dispara un WhatsApp; la respuesta del cliente vuelve
como update en ese item. La condición se arma en las automatizaciones
nativas de monday (no hay motor de reglas propio).

Alta por tenant (autenticado con la API key):

```bash
curl -X PUT https://cauce.digsol.com.mx/api/tenants/demo/conectores/monday \
  -H "x-api-key: $CAUCE_API_KEY" -H "content-type: application/json" \
  -d '{"instanceId":"<id de la sesión conectada>",
       "apiToken":"<API token de monday>",
       "signingSecret":"<Signing Secret de la app de monday>",
       "columnaTelefono":"<columnId del teléfono>",
       "plantilla":"Hola {{nombre}}, tu saldo de {{saldo}} vence hoy."}'
```

Luego, en monday: automatización nativa → acción **Webhook** apuntando a
`https://cauce.digsol.com.mx/webhooks/monday/demo`. monday manda el
challenge de verificación (se responde solo) y firma cada evento con el
Signing Secret. Variables de plantilla: `{{nombre}}` (nombre del item) y
`{{columnId}}` (texto de esa columna).

## Correr local

Requiere Node ≥ 22.

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev:console
```

La consola corre en `http://localhost:5173`, alimentada por el
`MockTransport` (sin backend). El orquestador, si se quiere levantar:

```bash
npm run dev:orchestrator
```

Queda en `http://localhost:3001`. Rutas bajo
`/api/tenants/:tenantId`: `POST /instances` (crea sesión),
`GET /instances/:id` (estado), `GET /instances/:id/qr`,
`POST /instances/:id/send`, `DELETE /instances/:id`. El webhook
entrante de cada instancia es
`POST /webhooks/:tenantId/:instanceId?token=…`.

### Ciclo completo con WhatsApp real

Requiere Docker corriendo (en macOS: `colima start`). Crea el
contenedor de la sesión, muestra el QR en la terminal, espera el
escaneo, envía un mensaje y imprime lo que responda el destinatario:

```bash
npx tsx scripts/prueba-ciclo.ts +5215512345678
```

La página de muestra del sistema visual es estática:
`packages/ui/muestra.html`.

## Cola y control de ritmo

Todo envío pasa por una cola persistida en disco (`data/cola/`), con
worker **por instancia** — el límite protege cada número por separado,
nunca es global. `POST /send` responde 202 con el id; el estado del
mensaje se consulta en `GET /instances/:id/messages`.

Valores por defecto (en `COLA_DEFAULTS`, configurables por tenant vía
`envioIntervaloMs`):

| Parámetro | Valor | Por qué |
|---|---|---|
| Intervalo entre envíos | 45 s | Cobranza no es tiempo real; ~80 mensajes/hora por número queda muy por debajo de los umbrales reportados de baneo, y el destinatario ya es cliente. |
| Jitter | +0–20 s uniforme | Cadencia perfectamente regular es señal de bot; el intervalo efectivo queda en 45–65 s. |
| Reintentos | 3 intentos | Un fallo transitorio (reconexión de sesión) se recupera; más de 3 casi siempre es sesión caída y conviene fallar visible. |
| Backoff | 60 s · 4ⁿ (1 min, 4 min, 16 min) | Da tiempo a que una reconexión termine antes de reintentar; no castiga la cola completa. |

Un mensaje que estaba `enviando` al caer el proceso vuelve a
`encolado` al arrancar: semántica al-menos-una-vez (en el peor caso
ese envío se duplica).

## Stack

Node 22 + Express + TypeScript · React 19 + Vite · Firestore ·
Google Secret Manager · Docker (dockerode) · EC2 (mx-central-1)
detrás de Caddy.
