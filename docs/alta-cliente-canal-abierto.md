# Alta de un cliente en el canal abierto de Bitrix24 (Contact Center)

Paso a paso tal como lo ejecuta Mau en el portal del cliente, desde crear la
aplicación local hasta el primer mensaje contestado por un agente. Cada paso
dice qué se captura en qué pantalla y qué línea de la bitácora lo confirma.
Escrito tras el dogfooding en el portal de Digsol (sep 2026); el primer
cliente será Procesa.

Tiempo: 30–40 min la primera vez; 15 min las siguientes. Casi todo es
navegar Bitrix. Nada de esto exige reiniciar ni desplegar el orquestador.

**Vocabulario.** *Línea* = un número de WhatsApp conectado (una instancia).
*App local* = la aplicación OAuth que vive en el portal de Bitrix del
cliente; hay una por portal. *Conector* = la ficha "WhatsApp · Digsol
Factory" que aparece en Contact Center al instalar la app. *Línea abierta*
(Open Channel) = la cola de Bitrix donde caen los chats, con sus agentes,
horario y reparto; es del cliente, no nuestra. *Handler* = la URL única del
tenant a la que Bitrix manda instalación, placement y eventos.

**Regla de secretos.** El `client_id` y el `client_secret` de la app local
se capturan **solo** en la pantalla de la plataforma. No van por chat, ni
por correo, ni a un documento. La plataforma no los vuelve a mostrar.

---

## 0. Antes de empezar

- [ ] **México desplegado** con `cb39d50` o posterior (múltiples
      números, instalación idempotente) y `CAUCE_URL_PUBLICA=https://api.factory.digsol.com.mx`.
      Comprobar: `curl -s https://api.factory.digsol.com.mx/health` devuelve
      `{"ok":true,"version":"<commit>"}` con ese commit o uno posterior.
- [ ] **Tenant del cliente en la plataforma** con plan **Estándar o Pro**
      (el canal abierto usa la capacidad `entrantes`; Básico no la tiene y
      el bloque aparece atenuado con "Requiere plan"). Si el tope de líneas
      del plan es menor al que el cliente necesita, fijar `limitesOverride`
      antes de conectar números.
- [ ] **La línea de WhatsApp ya conectada** en Sesiones (punto sólido
      verde). Bitácora: `instancia.crear … resultado=ok` y luego
      `instancia.estado … a=connected`. El canal abierto se cuelga
      de una línea existente; no crea ninguna.
- [ ] **Acceso de administrador al portal Bitrix del cliente.** Crear apps
      locales y canales abiertos exige administrador.
- [ ] **Plan del portal Bitrix.** Tope de líneas abiertas por plan (fuente:
      helpdesk de Bitrix24, "FAQ: Contact Center"): Free 1 · Basic 2 ·
      Standard 10 · Professional y Enterprise sin tope. Cada canal
      conectado va a **una sola** línea abierta. Si el cliente necesita más
      líneas abiertas de las que su plan permite, la subida de plan la paga
      el cliente y se cotiza antes.
- [ ] Un **teléfono que no sea el número conectado** para mandar el mensaje
      de prueba del paso 5.

---

## 1. Crear la aplicación local en el portal del cliente (Bitrix)

Dónde: Bitrix24 → **Aplicaciones** → **Recursos para desarrolladores** →
**Otro** → **Aplicación local**. (En inglés: Applications → Developer
resources → Other → Local application.)

Qué capturar:

| Campo | Valor |
|---|---|
| Nombre | `Digsol Factory · WhatsApp` (lo ve el cliente en su menú) |
| Tipo | **Aplicación de servidor** (Server application). No "solo script". |
| Ruta del handler | por ahora vacía o `https://api.factory.digsol.com.mx/` si el formulario la exige; se corrige en el paso 3 |
| Ruta de instalación inicial | igual que la anterior; se corrige en el paso 3 |
| Permisos (scope) | `imopenlines`, `imconnector`, `im`, `imbot`. Nada más. |

Guardar. Bitrix muestra **Código de aplicación** (`client_id`, con la forma
`local.xxxxxxxxxxxxxxxx.xxxxxxxx`) y **Clave de aplicación**
(`client_secret`). Dejar esta pestaña abierta: se pegan en el paso 2 y la
ruta se completa en el paso 3.

Bitácora: nada todavía. Bitrix no ha hablado con el orquestador.

---

## 2. Alta del canal en la plataforma

Dónde: Plataforma → **Integraciones** → tarjeta **Bitrix24** → Conectar →
bloque **Canal abierto (Contact Center)**.

Qué capturar:

| Campo | Valor |
|---|---|
| Dominio del portal | `procesa.bitrix24.mx` (acepta la URL completa pegada; se normaliza al host) |
| client_id | el Código de aplicación del paso 1 |
| client_secret | la Clave de aplicación del paso 1 |

Guardar. La pantalla pasa a mostrar la **URL del handler** con un botón
Copiar y la instrucción de pegarla en Bitrix.

Bitácora, línea que confirma:

```
openlines.alta tenant=<t> instancia=<i> dominio=procesa.bitrix24.mx resultado=creada
```

Qué pasó: los secretos quedaron cifrados en Firestore (`CAUCE_CRYPTO_KEY`).
El dominio declarado es el candado: **solo se aceptará la instalación que
venga de ese portal.** Un tercero que conozca el `tenantId` no puede
"instalar" su portal y llevarse los WhatsApp del cliente.

---

## 3. Pegar el handler e instalar la app

En la plataforma, **Copiar** la URL del handler. Tiene la forma
`https://api.factory.digsol.com.mx/bitrix/openlines/<tenantId>`.

En Bitrix, en la app local del paso 1:

1. **Ruta del handler** = la URL copiada.
2. **Ruta de instalación inicial** = la misma URL.
3. Guardar. Luego **Reinstalar** (o abrir la app desde el menú izquierdo).
   Bitrix manda `ONAPPINSTALL` al handler con los tokens OAuth.

Bitácora, línea que confirma:

```
openlines.instalada tenant=<t> dominio=procesa.bitrix24.mx conector=digsol_factory_<t> reinstalacion=false evento=enlazado
```

Si se reinstala (segunda vez en el mismo portal) la línea dice
`reinstalacion=true evento=ya_enlazado`. **Es correcto**, no un error: desde
`4a6521e` la instalación es idempotente. Antes fallaba con "Handler already
binded".

La plataforma cambia sola en unos segundos a: aro punteado naranja, *"App
instalada en procesa.bitrix24.mx. Falta asignar tus números a una línea
abierta."*, y aparece la tabla del paso 4.

Si en vez de `instalada` sale `openlines.instalacion_rechazada`:

| `motivo=` | Causa | Qué hacer |
|---|---|---|
| `el portal no es el declarado en el alta` | el dominio capturado en el paso 2 no coincide con el portal que instaló | corregir el dominio en la plataforma (Editar) y reinstalar |
| `client_endpoint no corresponde al portal declarado` / `sin HTTPS` | los tokens apuntan a otro servidor | no instalar; revisar de dónde vino el POST |
| `la aplicación ya está instalada en otro portal` | el tenant ya tiene tokens de otro `member_id` | Quitar el canal en la plataforma y volver a dar de alta |
| `app.info no corresponde a la app dada de alta` (con `campos=…`) | el `client_id` capturado no es el de la app que instaló | copiar de nuevo el Código de aplicación en la plataforma (Editar) y reinstalar. Si `campos=` no incluye `CODE`, avisar al dev: es el punto de `app.info` |

Qué pasó técnicamente: `imconnector.register` (la ficha en Contact Center) y
`event.bind` de `OnImConnectorMessageAdd` hacia el handler. **Nada llega a
ningún lado todavía.** La app instalada solo registra el conector: sin una
línea abierta a la que activarlo, no hay dónde entregar. Este es el paso que
nos costó diagnóstico en el dogfooding; ahora la bitácora lo dice (paso 5,
`resultado=omitido`) y la asignación se hace desde la plataforma (paso 4).

---

## 4. Asignar cada número a una línea abierta (desde la plataforma)

Con la app instalada, el bloque de la plataforma muestra la **tabla de
conjunto**: una fila por número de WhatsApp del tenant, con su id en chico,
el número, el estado real de conexión y la línea abierta que atiende. Es la
pantalla que se mira cuando el cliente llama. Desde ahí se hace toda la
asignación; **el cliente no necesita entrar a Contact Center**.

Regla del modelo: **cada número atiende exactamente una línea abierta; una
línea abierta puede tener varios números.** Un número en varias líneas no
existe: el entrante no sabría a cuál ir.

### 4a. Elegir la línea abierta de cada número

En la columna "Canal abierto asignado" de cada fila, el desplegable ofrece
**las líneas abiertas que el cliente ya tiene** en su portal, con su nombre,
su id y, si ya la atiende otro número, cuál. Se elige una y queda asignada.

Bitácora, línea que confirma:

```
openlines.asignacion tenant=<t> instancia=<i> numero=+52••••1234 linea=N resultado=asignada
```

La plataforma pasa a punto sólido verde: *"Activo: 1 número en 1 línea
abierta · procesa.bitrix24.mx"*. Con siete números, *"7 números en 7
líneas abiertas"* (o las que sean).

Qué pasó: `imconnector.activate` en esa línea y `connector.data.set`
describiendo el canal con los números que la atienden.

### 4b. Reasignar y compartir: con confirmación, nunca en silencio

- **Mover un número a otra línea** (ya atendía la 7 y se elige la 12): la
  fila avisa *"ya atiende la línea abierta #7; al moverlo deja de
  atenderla"* y pide **Sí, moverlo**. Bitácora:
  `openlines.asignacion … resultado=reasignada lineaAnterior=7 linea=12`.
  Si la línea 7 queda sin números, el conector se desactiva ahí.
- **Sumar un número a una línea que ya tiene otro**: la fila avisa *"esta
  línea abierta ya la atiende +52 442 ••• 1234; los chats de todos caerán
  en la misma cola"* y pide **Sí, compartir la línea**. Bitácora:
  `openlines.asignacion … resultado=asignada compartidaCon=1`. Es la forma
  de cubrir el tope de líneas abiertas del plan de Bitrix.
- **Quitar** deja el número sin línea abierta; la línea se desactiva si
  queda vacía. Bitácora: `… resultado=quitada`.

### 4c. Crear una línea abierta nueva (acción explícita)

Solo si el cliente la quiere: la última opción del desplegable, **"Crear
una línea abierta nueva…"**, abre un campo de nombre y el botón **Crear y
asignar**. Nunca se crea por default; Procesa ya tiene líneas abiertas para
otros canales y llenarles el portal se las comería del tope del plan.

La línea nace **activa y con el usuario que instaló la app como único
operador**. El equipo, el reparto y el horario se afinan en Bitrix
(Contact Center → Canales abiertos → la línea): la plataforma lo dice al
crearla.

Bitácora: `openlines.linea_creada tenant=<t> linea=N nombre="WhatsApp
Ventas" operador=<id>` y luego la `asignacion`.

Si Bitrix la rechaza por el tope del plan, la plataforma muestra el error
de Bitrix **tal cual** y añade el tope por plan (Free 1 · Basic 2 ·
Standard 10 · Professional sin tope) con las dos salidas: subir de plan en
Bitrix o compartir una línea existente.

### 4d. La otra puerta: desde Contact Center

Si el cliente llega por Bitrix, funciona igual: **Contact Center** → ficha
**WhatsApp · Digsol Factory** → elegir la línea abierta → **Conectar**.
Bitrix abre nuestra página dentro de su panel, con la lista de números,
su estado, quién atiende qué, y las mismas confirmaciones. Al terminar:
*"Conectado en la línea abierta 12 · +52 442 857 5347"* con el id de
instancia en chico.

Bitácora: `openlines.placement tenant=<t> linea=N` y después la
`asignacion`. `openlines.placement_rechazado … motivo="sin member_id"` o
`"member_id distinto"` significa que el POST no vino del portal instalado.

Si el cliente quiere la línea abierta configurada a su gusto antes de
asignar, la crea él en Bitrix (Contact Center → Canales abiertos → Crear:
nombre, cola o departamento, reparto uniforme / por orden / simultáneo,
horario) y aparece en el desplegable al pulsar **Actualizar**.

---

## 5. Primer mensaje y primera respuesta

### 5a. Entrante (contacto → Bitrix)

Desde el teléfono de prueba, mandar un WhatsApp de texto al número
conectado. Cuando el mensaje entra al orquestador se procesa y se entrega a
la línea abierta.

Bitácora, líneas que confirman, en este orden:

```
entrante.guardado … instancia=<i> …
openlines.entrante tenant=<t> instancia=<i> mensaje=<id> telefono=+52••••1234 linea=N chatBitrix=<id> sesionBitrix=<id> resultado=ok
```

En Bitrix, el chat aparece en la cola de la línea abierta N (Contact Center
/ Messenger) para los agentes configurados en 4a, con el nombre y teléfono
del contacto.

Si en vez de `resultado=ok` aparece `resultado=omitido`:

| `motivo=` | Falta |
|---|---|
| `número sin línea abierta asignada` | el paso 4a |
| `app no instalada en el portal` | el paso 3 |
| `instancia distinta a la del canal` (nivel info) | nada: el mensaje entró por otra línea de WhatsApp del tenant, que no es la de este canal |

Sin ninguna línea `openlines.entrante`: el tenant no tiene alta de canal
abierto (paso 2), o el mensaje no llegó al orquestador (revisar
`entrante.guardado` y el estado de la sesión).

### 5b. Respuesta del agente (Bitrix → contacto)

Un agente de la cola responde el chat desde Bitrix. Bitrix manda
`OnImConnectorMessageAdd` al handler; el orquestador lo saca por el carril
inmediato (sin la cola de 45–65 s) y confirma la entrega a Bitrix.

Bitácora, línea que confirma:

```
openlines.operador tenant=<t> instancia=<i> telefono=+52••••1234 imMensaje=<id> usuario=<idAgente> mensaje=<id> resultado=entregado humanaHasta=<ISO>
```

El teléfono de prueba recibe el texto. En Bitrix el mensaje queda marcado
como entregado.

Otras líneas que pueden aparecer y qué significan:

| Línea | Significado |
|---|---|
| `openlines.operador … resultado=ignorado motivo="mensaje del propio bot"` | eco del imbot; no se reenvía (sin rebote) |
| `openlines.rafaga … tope=10/60s resultado=encolado` | más de 10 respuestas en 60 s en esa línea: el excedente salió por la cola normal con espaciado. Es protección, no límite: no se perdió nada |
| `openlines.adjunto_no_soportado … archivos=1` | el agente mandó imagen/audio/archivo; v1 es solo texto. No se entrega ni se confirma; Bitrix lo muestra como no entregado |
| `openlines.evento_rechazado … motivo="application_token no coincide"` | un POST al handler que no viene del portal instalado. Se ignora con 401 |

### 5c. Ventana humana

Tras la primera respuesta del agente, la conversación queda en **ventana
humana 30 min** (configurable por tenant en `canalAbierto.ventanaHumanaMin`):
los bots del tenant no contestan esa conversación mientras dure. Cada
respuesta del agente la renueva. Bitácora: `bots.pausados_por_operador`.

---

## 6. imbot (solo Pro, opcional, pendiente de decisión)

No hacerlo en Procesa hasta cerrar la prueba de visibilidad del dogfooding
(decisión A o C). Cuando se haga: `POST
/api/tenants/<t>/conectores/bitrix-openlines/bot` (capacidad `bots`) →
`openlines.bot_registrado tenant=<t> botId=<n>`. Luego cada respuesta de bot
se refleja en el chat del agente: `openlines.bot_reflejado`.

---

## 7. Verificación final

Las seis líneas de bitácora, en orden, que dicen "este cliente quedó":

1. `openlines.alta … resultado=creada`
2. `openlines.instalada … evento=enlazado` (o `ya_enlazado`)
3. `openlines.asignacion … resultado=asignada linea=N`
4. `openlines.entrante … resultado=ok linea=N`
5. `openlines.operador … resultado=entregado`
6. (con varios números) una `asignacion` y un `entrante … ok` por cada
   número, cada uno con su `linea=` (distinta o compartida)

Para leerlas en el servidor:

```bash
journalctl -u factory --since "1 hour ago" -o cat | grep 'openlines\.'
```

---

## 8. Reinstalar, editar, quitar

- **Reinstalar desde Bitrix** (botón Reinstalar de la app local) es seguro:
  desde `4a6521e` no duplica ni falla. Bitácora: `reinstalacion=true`.
- **Cambiar la línea de WhatsApp o el dominio**: Editar en el bloque de la
  plataforma. Si cambia el dominio, la instalación existente deja de
  coincidir: hay que Quitar y volver a dar de alta (la app local se instala
  de nuevo en el portal correcto).
- **Quitar**: primero en Bitrix (Aplicaciones → la app local → eliminar; se
  lleva el conector y sus eventos), después en la plataforma (Quitar, que
  borra el alta cifrada). Bitácora: `openlines.baja`.
- **Rotación de secretos de la app** (nueva Clave de aplicación en Bitrix):
  Editar en la plataforma con el nuevo `client_secret` y Reinstalar en
  Bitrix. Los tokens OAuth se renuevan solos (`openlines.token_renovado`).
