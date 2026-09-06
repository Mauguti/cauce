# Deploy de Cauce

Dos piezas independientes: la **consola** (estática, Firebase Hosting)
y el **orquestador** (Node en el host de una EC2, detrás de Caddy).

- Consola desplegada: https://cauce-consola.web.app
- Orquestador: `https://<tu-dominio>` (ver más abajo)

---

## 1. Consola — Firebase Hosting

Proyecto `cauce-consola` (solo Hosting; Firestore fuera de alcance).

La consola apunta al orquestador por variable de build. Edita
`apps/console/.env.production` con la URL real del orquestador antes de
compilar:

```bash
# apps/console/.env.production
VITE_CAUCE_API=https://api.tudominio.mx
```

Compila y publica:

```bash
npm run build -w @cauce/console
```

```bash
firebase deploy --only hosting --project cauce-consola
```

El deploy imprime la Hosting URL. Esa URL es la que debe ir en la
allowlist de CORS del orquestador (`CAUCE_CORS_ORIGENES`).

---

## 2. Orquestador — EC2 Ubuntu en mx-central-1

### 2.1 Instancia y red

- EC2 Ubuntu 24.04 LTS en `mx-central-1`, tipo con ≥ 4 GB de RAM
  (cada sesión de Evolution consume varios cientos de MB).
- **Security group**: entrada solo
  - `443/tcp` desde `0.0.0.0/0`
  - `22/tcp` desde **tu IP** únicamente (`X.X.X.X/32`)
  - nada más. El 8080 de Evolution nunca se expone: vive en
    `cauce-net` y se publica solo en loopback (ADR 0003).
- Un Elastic IP y un registro A `api.tudominio.mx → EIP`.

### 2.2 Docker y el grupo `docker` (el tropiezo más probable)

dockerode habla al socket `/var/run/docker.sock`. Ese socket es del
grupo `docker`; si el usuario del servicio no está en el grupo,
dockerode falla con `EACCES ... /var/run/docker.sock`. **Verifícalo
antes que nada.**

```bash
sudo apt-get update && sudo apt-get install -y docker.io
```

```bash
sudo usermod -aG docker ubuntu
```

El cambio de grupo aplica en una sesión nueva: cierra SSH y vuelve a
entrar (o `newgrp docker`). Verifica sin sudo:

```bash
docker ps
```

Si `docker ps` responde sin sudo, dockerode funcionará. Si da
`permission denied`, el servicio también fallará: no sigas hasta
resolverlo.

### 2.3 Node 22 y el código

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs
```

```bash
git clone <repo> /opt/cauce && cd /opt/cauce && npm ci
```

Pre-descarga las imágenes fijadas (evita timeout en la primera sesión):

```bash
docker pull evoapicloud/evolution-api:v2.3.7 && docker pull postgres:16.6-alpine
```

### 2.4 Firestore (persistencia)

El orquestador usa Firestore cuando detecta credenciales; sin ellas cae
al repositorio en memoria (solo dev). Colecciones según el modelo de
`@cauce/core`: `tenants/{tenantId}`, `tenants/{tenantId}/instances/{id}`,
`tenants/{tenantId}/messages/{id}`.

- Crea una service account con rol **Cloud Datastore User** en el
  proyecto GCP y baja su JSON. **No va en el repo**; súbelo al host con
  permisos `600` (p. ej. `/etc/cauce-firestore.json`) y apúntalo con
  `GOOGLE_APPLICATION_CREDENTIALS` en el EnvironmentFile.
- **Índices**: las consultas actuales (`listMessages` filtra por
  `instanceId`, sin `orderBy`) usan solo índices de campo único, que
  Firestore crea automáticamente — **no hace falta índice compuesto**.
  El orden por `timestamp` lo hace el orquestador en memoria. Si en el
  futuro se empuja el `orderBy` a Firestore, hará falta un índice
  compuesto `messages(instanceId ASC, timestamp ASC)`.

### 2.5 Secretos y systemd

Los secretos van en el entorno del servicio, **nunca en el repo**.
El `EnvironmentFile` lo lee root; permisos `600`.

```bash
sudo install -m 600 /dev/null /etc/cauce.env
```

Edítalo (`sudo nano /etc/cauce.env`) con:

```
CAUCE_API_KEY=<genera: openssl rand -hex 24>
CAUCE_CORS_ORIGENES=https://cauce-consola.web.app
CAUCE_URL_WEBHOOKS=http://host.docker.internal:3001
CAUCE_DATA_DIR=/var/lib/cauce
GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json
PORT=3001
```

Sin `GOOGLE_APPLICATION_CREDENTIALS` (ni `FIRESTORE_PROJECT_ID`) el
orquestador cae al repositorio en memoria y pierde el historial en cada
reinicio; en producción esa variable es obligatoria.

```bash
sudo mkdir -p /var/lib/cauce && sudo chown ubuntu:ubuntu /var/lib/cauce
```

Unit de systemd con restart automático — `/etc/systemd/system/cauce.service`:

```ini
[Unit]
Description=Cauce orchestrator
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/cauce
EnvironmentFile=/etc/cauce.env
ExecStart=/usr/bin/npx tsx apps/orchestrator/src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cauce
```

```bash
sudo systemctl status cauce && journalctl -u cauce -n 30 --no-pager
```

En el log de arranque deben verse `sesiones rehidratadas desde
Docker: N` y `orquestador escuchando en :3001`. Si aparece
`Docker no disponible`, vuelve al paso 2.2.

### 2.6 Caddy — TLS y único servicio publicado

Caddy publica **solo** el orquestador y obtiene TLS automático.

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
api.tudominio.mx {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

Caddy resuelve el certificado con Let's Encrypt al primer request.
Prueba desde fuera:

```bash
curl https://api.tudominio.mx/health
```

Debe responder `{"ok":true}`.

### 2.7 Cerrar el círculo

1. Pon `VITE_CAUCE_API=https://api.tudominio.mx` en
   `apps/console/.env.production`, recompila y redeploya la consola
   (paso 1).
2. Confirma que `CAUCE_CORS_ORIGENES` en `/etc/cauce.env` es
   exactamente la Hosting URL (sin barra final).
3. Abre la consola, entra con `CAUCE_API_KEY`, crea una sesión y
   escanea el QR.

---

## Notas de operación

- **Rehidratación**: al reiniciar el servicio, el orquestador
  reconstruye las sesiones desde los contenedores `cauce-*`. Los
  contenedores sobreviven al reinicio del proceso; no los borres a
  mano.
- **Backups**: el estado que importa vive en los volúmenes Docker
  `cauce-db-data` (Postgres) y `cauce-auth-*` (sesiones), más
  `/var/lib/cauce` (cola). Inclúyelos en el snapshot del EBS.
- **Rotar la API key**: cambia `CAUCE_API_KEY` en `/etc/cauce.env` y
  `sudo systemctl restart cauce`. (Rotación con solapamiento: TODO,
  junto con Secret Manager.)
