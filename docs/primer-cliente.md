# Puesta en marcha con un board real (We Build, luego Procesa)

Checklist en orden para conectar un board real de monday a un número de
WhatsApp y ver el primer mensaje. Pensado para dárselo a alguien que no
conoce el producto. Tiempo estimado: 20–30 min (la mayoría es esperar el
QR y crear la automatización en monday).

Vocabulario: **línea** = un número de WhatsApp conectado. **conector** =
la conexión con un CRM (hoy solo monday). En plan de prueba tienes 1 de
cada uno, por 14 días.

---

## 0. Lo que hay que tener a la mano

- [ ] El **teléfono** cuyo WhatsApp vas a conectar, con la app abierta
      para escanear un QR (WhatsApp → Ajustes → Dispositivos vinculados).
- [ ] Acceso al **board de monday** del cliente, con permiso para crear
      automatizaciones.
- [ ] Un **API token de monday** (paso 2).
- [ ] *(Opcional)* un **Signing Secret** de una app de monday, si quieres
      que los disparos vengan firmados (paso 2). Se puede dejar para
      después.

---

## 1. Conectar el número (una línea)

1. Entra a la consola (https://cauce-consola.web.app) con tu cuenta.
2. **Sesiones → Conectar número.** Toma ~1 min en levantar; luego aparece
   un **QR**.
3. Escanéalo desde el teléfono (Dispositivos vinculados → Vincular
   dispositivo). El estado pasa a **Conectada** (punto verde).

> Si topas con "Tu plan permite 1 línea": ya tienes una conectada.
> Elimínala o sube de plan para agregar otra.

---

## 2. Sacar el token (y el signing secret) de monday

**API token** (obligatorio):
1. En monday, clic en tu avatar (abajo a la izquierda) → **Developers**.
2. En **My Access Tokens**, copia tu token personal (o crea uno). Es una
   cadena larga; da acceso a tu cuenta, trátalo como contraseña.

**Signing Secret** (opcional, recomendado para producción):
1. **Developers → tu app → Basic Information.** Copia el *Signing
   Secret*.
2. Si aún no tienes una app de monday, déjalo vacío por ahora; el
   webhook seguirá funcionando con la verificación de alta.

---

## 3. Preparar el board

El board necesita, como mínimo:

- **Una columna de teléfono**, tipo *Phone* o *Text*, con el número del
  cliente en formato internacional (p. ej. `+52 55 1234 5678`). Si está
  vacía en un item, ese disparo fallará con "el item no tiene teléfono".
- Las **columnas que uses en la plantilla** (nombre del item, saldo,
  fecha, etc.), llenas en los items que vayan a disparar.

---

## 4. Conectar monday en la consola

1. **Conexiones → monday → Configurar.**
2. Elige el **número** desde el que se envía (la sesión del paso 1).
3. Pega el **API token** y da **Probar conexión** → lista tus boards.
4. Elige el **board** → lista sus columnas.
5. Mapea la **columna del teléfono** (solo aparecen las de tipo teléfono
   o texto).
6. *(Opcional)* pega el **Signing Secret**.
7. **Guardar conexión.** Queda como "monday conectado ✓".

---

## 5. Escribir la plantilla

1. **Acciones → Salientes.**
2. Escribe el mensaje e inserta variables con los botones de columna
   (p. ej. `Hola {{nombre}}, tu saldo de {{saldo}} vence hoy.`). La
   **vista previa** muestra cómo queda con datos de ejemplo.
3. **Guardar plantilla** (confirma "Plantilla guardada ✓").

---

## 6. Crear la automatización en monday (el paso más frágil)

1. En **Acciones → Salientes**, **Copia** la URL del webhook.
2. En tu board de monday, arriba a la derecha abre **Integrar** (icono de
   enchufe) y busca la app **Webhooks**.
3. Elige la receta **"When a column changes, send a webhook"** — o
   **"When status changes to something…"** si disparas por estatus. Para
   cobranza, lo típico: *cuando la fecha de pago es hoy* o *cuando el
   estatus cambia a "Recordar"*.
4. En el paso del **webhook URL**, pega la URL y guarda. monday manda una
   verificación al guardar (se responde sola).
5. *(Alternativa sin la app Webhooks)* **Automatizaciones → Crear
   automatización →** acción **"Send a webhook"** con la misma URL.

---

## 7. Verificar que llegó el disparo

- En **Acciones → Salientes**, el estado del webhook:
  - **"monday aún no ha llamado"** → todavía no se cumplió la condición o
    la automatización no está activa. Revisa: URL pegada completa, la
    condición se cumple en algún item, y la automatización está activa
    (no en borrador).
  - **"✓ Conectado. monday llamó por última vez: …"** → llegó el disparo.
- En **Inicio (dashboard)**, el mensaje aparece en el registro de envíos:
  **Encolado → Enviado** (o **Fallido** con su causa).
- La respuesta del cliente vuelve al item de monday como *update* y a la
  **Conversación** de esa línea.

Para una prueba controlada: en un item con teléfono válido (tu propio
número), cumple la condición (cambia la columna/estatus) y observa el
dashboard.

---

## 8. Si no sale el mensaje — diagnóstico

El dashboard muestra la causa de cada envío fallido. Qué hacer según la
causa:

| Causa en el dashboard | Qué pasó | Cómo corregir |
|---|---|---|
| **Sesión desconectada** | La línea estaba desconectada al enviar | Reconéctala en Sesiones (escanea el QR) y usa **Reintentar** en el mensaje |
| **El item no tiene teléfono en la columna mapeada** | La columna de teléfono está vacía en ese item | Llena la columna en monday y vuelve a disparar (Reintentar no aplica) |
| **Teléfono con formato inválido** | El número no es E.164 | Corrige el número en el item (usa `+52…`) y dispara de nuevo |
| **El item no tiene los datos de la plantilla** | El mensaje quedó vacío | Llena las columnas que usa la plantilla en ese item |
| **WhatsApp rechazó el envío** | El transporte rechazó (número sin WhatsApp, límite…) | Verifica el número; **Reintentar** tras corregir |

- **Reintentar** re-manda el mismo mensaje sin recrear la acción ni
  esperar otro evento. Solo aparece cuando reintentar tiene sentido.
- Si "monday nunca llamó", el problema está en la **automatización de
  monday**, no en Cauce: revisa el paso 6.
- Si un mensaje sale como **Sin confirmar** (o el tablero avisa de una
  **sesión degradada**): WhatsApp aceptó el envío pero no confirmó la
  entrega. Casi siempre es un número quemado por crear/borrar sesiones en
  ráfaga. **No lo elimines: desconéctalo y reconéctalo.** El detalle, en
  [`docs/mensajes-pendientes.md`](mensajes-pendientes.md).

---

## Estado conocido (al escribir esto)

- Los envíos se prueban de punta a punta hasta *Encolado*; la entrega
  real requiere la línea **Conectada** (QR escaneado).
- Falta un despliegue del orquestador en EC2 con esta versión antes de
  operar en producción (ver `docs/deploy.md` y `scripts/deploy.sh`), y —
  para el login con Google— agregar `cauce-consola.web.app` a los
  dominios autorizados de Firebase Auth.
