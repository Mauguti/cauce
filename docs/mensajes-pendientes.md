# Mensajes que se quedan en PENDING (y cómo evitarlo)

Guía del problema más caro que hemos tenido: **Cauce dice "enviado" pero
el mensaje nunca llega**. La causa no es de Cauce — es de Evolution API /
Baileys, la capa que habla con WhatsApp — pero un cliente puede
dispararla solo. Este documento explica qué es, qué lo provoca, cómo lo
detecta Cauce ahora, y qué hacer cuando pasa.

> Para el operador de soporte: la sección **"Qué decirle al cliente"** de
> abajo es lo que evita el ticket. Lo demás es el porqué.

---

## Qué es

WhatsApp acusa cada mensaje saliente en varios pasos (estados de Baileys):

| # | Estado | Significa |
|---|--------|-----------|
| 0 | ERROR | WhatsApp rechazó el mensaje |
| 1 | PENDING | Se aceptó la petición; aún no salió |
| 2 | SERVER_ACK | El servidor de WhatsApp lo recibió (✓) |
| 3 | DELIVERY_ACK | Llegó al teléfono del destinatario (✓✓) |
| 4 | READ | Lo leyeron |

Un envío sano pasa a **SERVER_ACK en segundos**. El bug es que el mensaje
se queda en **PENDING para siempre**: la API responde `201 Created` con un
`key.id`, pero nunca hay SERVER_ACK y el destinatario no recibe nada.

**Síntoma exacto:** los **entrantes funcionan** (recibes mensajes y los
disparadores responden) y los **grupos funcionan**, pero los **privados
salientes** se quedan en PENDING. Es específico porque los grupos usan
otra criptografía (sender-key) que se renegocia sola; los privados
dependen de la sesión Signal por contacto, que es la que se corrompe.

---

## Qué lo provoca

Dos cosas, que suelen ir juntas:

1. **Crear y borrar el mismo número en ráfaga.** Cada alta/baja deja
   sesiones Signal y prekeys viejas. En la siguiente sesión el número
   "autentica" (aparece `connectionStatus: open`) pero cifra contra
   claves inválidas → el destinatario no puede descifrar → PENDING. En los
   logs del contenedor se ve como `SessionEntry` abriendo y cerrando y
   mensajes tipo *"Closing stale open session for new outgoing prekey
   bundle"*.

2. **La migración de WhatsApp a LID (Linked Identity).** Cambió el
   direccionamiento de los contactos (`@lid` en vez de `@s.whatsapp.net`)
   y la versión de Baileys dentro de Evolution 2.3.7 lo maneja mal en
   algunos casos.

Es un problema **conocido y abierto** de Evolution/Baileys:

- Evolution API #2626 — *Private messages remain PENDING while group
  messages work (v2.3.7)* — nuestro caso exacto:
  https://github.com/evolution-foundation/evolution-api/issues/2626
- Evolution API #2597 — *Outgoing messages stuck in PENDING* (sigue en
  2.4.0, subir de versión no lo cura):
  https://github.com/evolution-foundation/evolution-api/issues/2597
- Evolution API #2653 — *status 0 / stub 463* (probaron varios números y
  seguía; descarta que sea "un número malo"):
  https://github.com/evolution-foundation/evolution-api/issues/2653
- Baileys — familia *"Closing stale open session for new outgoing prekey
  bundle"*: #888, #1671, #1785, #1871 en
  https://github.com/WhiskeySockets/Baileys/issues

No hay fix estable a la fecha (última estable: Evolution **2.3.7**; 2.4.0
solo en release candidate). La mitigación es **operativa**: no quemar el
número.

---

## Cómo lo detecta Cauce (bloque 12)

Antes Cauce marcaba `enviado` con solo recibir el `201`. Ahora distingue
**aceptado** de **entregado**:

- La instancia se suscribe a `MESSAGES_UPDATE`; cada mensaje registra su
  entrega real (SERVER_ACK → `confirmadoEn`).
- Un `enviado` que lleva **más de 3 minutos sin confirmación** pasa a
  **`no_confirmado`** (un barrido corre cada minuto → se detecta en ~4 min
  como máximo).
- Si **varios salientes seguidos** quedan sin confirmar, el tablero avisa
  con un banner que nombra el número y dice qué hacer.

Así, cuando vuelva a pasar, el tablero lo dice en minutos en vez de
costarnos horas de "pero si dice enviado".

---

## Cómo evitarlo (y qué decirle al cliente)

**La regla de oro: si un número deja de funcionar, RECONECTARLO, no
eliminarlo y crear otro.** Eliminar + crear en ráfaga es justo lo que lo
degrada.

Cauce ya empuja hacia ahí:

- Al eliminar un número, el botón recomendado es **"Mejor desconectar"**;
  eliminar queda como acción de peligro.
- Si detecta que estás creando/borrando en ráfaga, **avisa antes de crear
  otro**.
- No destruye una sesión si no **confirma el logout** primero (así no
  quedan dispositivos vinculados colgando).

### Qué decirle al cliente cuando ya pasó

1. En **Sesiones**, **Desconecta** el número y **Reconéctalo** escaneando
   el QR de nuevo (no lo elimines).
2. Si sigue igual, desde el **teléfono**: WhatsApp → Dispositivos
   vinculados → cerrar la sesión de Cauce, y volver a vincular.
3. Si aun así no entrega, el número necesita **descansar unas horas**
   (WhatsApp lo tiene marcado). No sirve seguir recreándolo — lo empeora.
4. Para descartar que sea el número: probar un **número distinto** en una
   instancia limpia. Si ese entrega, era el número degradado.

### Cómo confirmarlo por API (para soporte técnico)

Consulta el estado real de un mensaje en el contenedor de la instancia:

```bash
curl -s -H "apikey: $APIKEY" \
  "http://localhost:8080/chat/findMessages/cauce-<tenant>-<instance>" \
  -H 'content-type: application/json' \
  -d '{"where":{"key":{"id":"<messageId>"}}}'
```

Si el `status` se queda en `PENDING` y nunca pasa a `SERVER_ACK`, es este
problema: sesión/numero degradado, no la red.
