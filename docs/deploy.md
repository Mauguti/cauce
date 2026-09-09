# Deploy de Digsol Factory

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

> **No crees `cauce-db` a mano.** El orquestador levanta él solo el
> contenedor Postgres compartido `cauce-db` con el usuario `cauce`, una
> base de datos por instancia, y guarda el password generado en el
> label `cauce.db.password` de ese contenedor. Las instancias de
> Evolution leen el password de ahí. Si creas `cauce-db` manualmente
> (otro usuario, otro password, sin el label), las instancias no podrán
> conectarse a su base y el arranque de cada sesión fallará. Si necesitas
> empezar de cero: `docker rm -f cauce-db && docker volume rm
> cauce-db-data` y deja que el orquestador lo recree.

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
CAUCE_CRYPTO_KEY=<genera: openssl rand -hex 32>
CAUCE_ADMIN_KEY=<genera: openssl rand -hex 24>
CAUCE_CORS_ORIGENES=https://cauce-consola.web.app
CAUCE_URL_WEBHOOKS=http://host.docker.internal:3001
CAUCE_DATA_DIR=/var/lib/cauce
GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json
PORT=3001
```

Sin `GOOGLE_APPLICATION_CREDENTIALS` (ni `FIRESTORE_PROJECT_ID`) el
orquestador cae al repositorio en memoria y pierde el historial en cada
reinicio; en producción esa variable es obligatoria.

### Bitácora de operación

Cada operación deja una línea en el journal, en formato `clave=valor`:

```
<ISO> <nivel> <evento> tenant=… instancia=… resultado=… ms=…
```

Eventos: `tenant.provisionar`, `instancia.crear|estado|reconectar|desconectar|eliminar|rehidratar`,
`qr.servido` (a lo sumo una vez por minuto e instancia), `envio.solicitado|encolado|enviado|reintento|fallido|directo|reintento_manual`,
`webhook.recibido|rechazado`, `entrega.confirmada|error|sin_coincidencia`, `entrante.guardado`,
`entrada.motor|monday|bitrix`, `auth.rechazada`, `prueba.vencida`, `http.error`.
Los teléfonos van enmascarados (`+52••••5347`). `CAUCE_LOG_WEBHOOKS=1` agrega el payload crudo a `webhook.recibido`.

Recetas:

```bash
# Todo lo de una instancia
sudo journalctl -u factory --no-pager | grep "instancia=f77d6518"
# Envíos que no salieron, y entregas que WhatsApp no confirmó
sudo journalctl -u factory --no-pager | grep -E "envio\.(fallido|reintento)|entrega\.(error|sin_coincidencia)"
# ¿Llegan los webhooks de Evolution? (si no hay líneas, no llegan)
sudo journalctl -u factory --no-pager | grep -c "webhook.recibido"
```

### `CAUCE_FIRESTORE_DB` — base de datos con nombre (opcional)

Dos orquestadores sobre el mismo proyecto Firebase compartirían la base
`(default)` y se verían los tenants entre sí. Para aislarlos, cada uno
apunta a su propia base con nombre dentro del proyecto:

```
CAUCE_FIRESTORE_DB=factory
```

- **Sin la variable** el comportamiento es idéntico al de siempre: base
  `(default)`. El orquestador de Cauce no la define.
- La base hay que crearla antes en la consola de Firebase (Firestore →
  Agregar base de datos) y desplegarle sus propias reglas; las reglas de
  `(default)` no aplican a las bases con nombre.
- Al arrancar, el log dice `repositorio: Firestore (base: <id>)`; ahí se
  confirma a cuál apunta. Cambiarla exige reiniciar el servicio
  (`sudo systemctl restart cauce`).

Variables nuevas del bloque 8:

- `CAUCE_ADMIN_KEY` — protege el endpoint de cambio de plan
  (`POST /api/admin/tenants/:id/plan`, header `x-admin-key`). Sin ella,
  ese endpoint queda deshabilitado.
- `CAUCE_API_KEY` sigue siendo la key del tenant `demo` (máquina a
  máquina). Los clientes nuevos ya **no** usan API key: entran con
  Firebase Auth y la consola manda el ID token.
- **NO definir `CAUCE_AUTH_DEV` en producción.** Con `CAUCE_AUTH_DEV=1`
  los ID tokens se aceptan sin verificar (solo desarrollo local). En
  producción debe estar ausente para que el orquestador verifique los
  tokens con el Admin SDK (usa `GOOGLE_APPLICATION_CREDENTIALS`).

### Firebase Auth (login de usuarios)

- El orquestador verifica los ID tokens con firebase-admin, usando las
  credenciales de `GOOGLE_APPLICATION_CREDENTIALS` (la misma service
  account de Firestore, proyecto `cauce-consola`).
- **Habilitar los proveedores una vez** en la consola de Firebase
  (Authentication → Sign-in method): Email/Password y Google. Es un paso
  manual de UI; sin él, el login de la consola falla.
- La consola de producción se compila **sin** `VITE_AUTH_DEV` y con
  `VITE_CAUCE_API=https://<tu-dominio>`. Debe desplegarse **junto con**
  esta versión del orquestador: la consola nueva llama
  `POST /api/provisionar`, que no existe en orquestadores anteriores.

### `CAUCE_CRYPTO_KEY` — llave de cifrado de credenciales

Cifra en reposo los tokens que los clientes conectan (API token y
signing secret de monday; AES-256-GCM). **Es tan sensible como los
tokens que protege.**

- **Generarla:** `openssl rand -hex 32` (cualquier cadena sirve; se
  deriva con scrypt, pero usa una larga y aleatoria).
- **Perderla = perder acceso a las credenciales guardadas.** Los tokens
  cifrados en Firestore quedan ilegibles: el conector no podrá leer ni
  escribir en monday y cada cliente tendrá que **volver a pegar** su
  token en Conexiones. No hay recuperación; la llave no vive en ningún
  otro lado.
- **No rotarla sin recapturar los tokens.** Cambiar la llave invalida
  todo lo ya cifrado. Si necesitas rotarla: cámbiala, reinicia, y pide a
  cada cliente que reingrese su token (o guárdalos de nuevo por API).
  Una rotación con solapamiento (descifrar con la vieja, recifrar con la
  nueva) es un TODO, no está implementada.
- **Respáldala** junto con —pero por separado de— el snapshot de
  Firestore. Sin la llave, el backup de credenciales no sirve.
- Si la variable falta, el orquestador arranca con una llave de
  desarrollo **insegura** y lo advierte en el log; nunca dejes producción
  así.

```bash
sudo mkdir -p /var/lib/cauce && sudo chown ubuntu:ubuntu /var/lib/cauce
```

Unit de systemd con restart automático — `/etc/systemd/system/cauce.service`:

```ini
[Unit]
Description=Digsol Factory orchestrator
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
3. Abre la consola, entra con tu cuenta y crea una sesión.

## 3. Despliegue sin desfase — `scripts/deploy.sh`

Consola y orquestador se despliegan por separado; si quedan en
versiones distintas, la consola llama rutas que el orquestador aún no
tiene (o al revés) y aparecen bugs fantasma. Para evitarlo:

- El orquestador expone su versión en `GET /health`
  (`{"ok":true,"version":"<commit corto>"}`), tomada de `CAUCE_VERSION`.
- La consola se compila con `VITE_CAUCE_VERSION` (mismo commit) y, al
  arrancar, compara contra `/health`. Si difieren, muestra un aviso
  visible: «Hay una versión más reciente disponible, recarga». No es una
  falla silenciosa.
- **`scripts/deploy.sh`** hace los dos pasos en orden (orquestador →
  consola) con la MISMA versión y verifica al final que `/health` la
  reporte:

```bash
CAUCE_SSH=ubuntu@<ip-ec2> CAUCE_API_URL=https://cauce.digsol.com.mx \
  scripts/deploy.sh
```

El script exige el árbol limpio, hace `git checkout` del commit en la
EC2, fija `CAUCE_VERSION` en `/etc/cauce.env`, reinicia el servicio,
compila la consola con esa versión y `VITE_CAUCE_API`, la publica en
Hosting, y al cierre confirma que `/health` reporta el commit desplegado.
Flags: `--solo-consola`, `--solo-orquestador`.

---

## Notas de operación

- **Rehidratación**: al reiniciar el servicio, el orquestador
  reconstruye las sesiones desde los contenedores `cauce-*`. Los
  contenedores sobreviven al reinicio del proceso; no los borres a
  mano.
- **Backups**: el estado que importa vive en los volúmenes Docker
  `cauce-db-data` (Postgres) y `cauce-auth-*` (sesiones), más
  `/var/lib/cauce` (cola) y Firestore. Inclúyelos en el snapshot del EBS.
  Respalda `CAUCE_CRYPTO_KEY` por separado: sin ella, las credenciales
  cifradas en Firestore son irrecuperables (ver arriba).
- **Rotar la API key**: cambia `CAUCE_API_KEY` en `/etc/cauce.env` y
  `sudo systemctl restart cauce`. (Rotación con solapamiento: TODO,
  junto con Secret Manager.) Para `CAUCE_CRYPTO_KEY` la rotación exige
  recapturar los tokens de cada cliente — no la cambies a la ligera.
