# Cauce

Capa de mensajería para CRMs. Conecta el CRM que la empresa ya usa con
el número de WhatsApp que sus clientes ya tienen guardado: el CRM
dispara el mensaje, Cauce lo envía desde el número propio del cliente,
y la respuesta vuelve escrita al registro que la originó.

> Cauce: el canal natural por donde fluye el agua. Aquí, por donde
> fluye la conversación — sin importar qué transporte corra debajo.

## Estructura

| Ruta | Qué es |
|---|---|
| `apps/orchestrator` | Servicio Node (Express). Único expuesto a internet. |
| `apps/console` | Frontend React. Hoy: lista de instancias del tenant. |
| `packages/core` | Tipos y modelo de datos compartidos. |
| `packages/transports` | Interfaz `MessageTransport` + implementaciones. |
| `packages/ui` | Tokens del sistema visual y componentes base. |
| `docs/adr` | Decisiones de arquitectura. |

Las decisiones que gobiernan todo el código están en
[docs/adr/0001](docs/adr/0001-transporte-intercambiable.md)
(transporte intercambiable),
[docs/adr/0002](docs/adr/0002-multitenancy.md) (multitenancy) y
[docs/adr/0003](docs/adr/0003-socket-docker.md) (acceso al socket de
Docker y red de contenedores).

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

## Stack

Node 22 + Express + TypeScript · React 19 + Vite · Firestore ·
Google Secret Manager · Docker (dockerode) · EC2 (mx-central-1)
detrás de Caddy.
