# Plan de mudanza de Procesa: Ohio (Cauce) → México (Digsol Factory)

Borrador para aprobación de Mau. **Nada de esto se ejecuta hasta que Mau lo
apruebe por escrito**, línea por línea. Ohio sigue congelada: no recibe
código nuevo, no se toca su Firestore ni sus contenedores salvo en los
pasos marcados como "Ohio" de este plan, y solo en la ventana acordada.

Referencias: `docs/deploy.md` (sección "Ohio congelada"),
`docs/alta-cliente-canal-abierto.md` (alta del Contact Center),
`docs/deploy.md` § `CAUCE_CRYPTO_KEY`.

---

## 0. Qué es mover un cliente (y qué no)

Mover **no es copiar documentos**. Son tres cosas distintas, cada una con su
propio mecanismo:

| Qué | Por qué no se copia tal cual | Cómo se mueve |
|---|---|---|
| **Sesiones de WhatsApp** | el estado de sesión vive en un volumen de Docker de Ohio, atado a esa máquina; dos hosts con la misma sesión se desconectan mutuamente | contenedor nuevo en México y **reescaneo del QR** desde el teléfono, línea por línea |
| **Credenciales de CRM** (token de monday, webhook/token de Bitrix) | están cifradas con la `CAUCE_CRYPTO_KEY` de Ohio, que no es la de México; en México serían ilegibles | **recaptura en la plataforma** por el cliente o por Mau, desde la pantalla de Integraciones |
| **Historial** (mensajes y conversaciones) | está en la base *default* del proyecto Firebase, bajo el tenant de Ohio; México usa la base `factory` con otro tenant y otros ids de instancia | **script de copia** con mapeo de ids (pieza pendiente, §2.3) |

Lo que **no existe en Ohio y no se mueve**: canal abierto de Bitrix
(Contact Center), planes con capacidades, bitácora. Todo eso nace en México.

Lo que **el cliente no pierde en ningún momento**: sus números de WhatsApp
siguen funcionando en sus teléfonos. Lo que se interrumpe durante la ventana
es la automatización (disparos desde el CRM, entrega a la bandeja, historial
en la plataforma), no WhatsApp.

---

## 1. Prerrequisitos (antes de fijar fecha)

- [ ] **Diseño de múltiples números por tenant decidido e implementado**
      en México, con dogfooding en la línea de Mau. Sin esto, Procesa solo
      podría tener un número en el Contact Center.
- [ ] **Capacidad en México.** Ocho sesiones a ~324 MiB cada una no caben
      en la EC2 actual (2 GiB). Redimensionar **antes** de la primera tanda
      (ver el análisis de capacidad enviado a Mau; el cambio de tipo de
      instancia se hace con stop/start y los volúmenes de sesión
      sobreviven, ~10 min de corte). Confirmar con `free -m` que la RAM
      libre soporta la tanda siguiente antes de cada tanda.
- [ ] **Plan del portal Bitrix de Procesa** suficiente para el número de
      líneas abiertas que quieran (Basic 2, Standard 10, Professional sin
      tope). Si hay que subir de plan, es costo de Procesa y se cotiza
      antes.
- [ ] **Tenant de Procesa en México.** Firebase Auth es compartido entre
      Ohio y México: el primer login de un usuario de Procesa en la
      plataforma provisiona un tenant vacío en la base `factory`
      (`tenant.provisionar` en bitácora). Hacerlo **a propósito y
      controlado**: Mau acompaña ese primer login (o lo hace con la cuenta
      administradora de Procesa acordada) al inicio del paso 3, no antes.
      Hasta entonces, **no compartir la URL de la plataforma con Procesa**.
- [ ] **Plan y topes del tenant**: Estándar o Pro (canal abierto exige
      `entrantes`); `limitesOverride` con el número de líneas contratado si
      el tope del plan es menor.
- [ ] **Inventario de Ohio para Procesa** (lo saca Mau del Firestore
      default / la consola de Cauce; el dev no entra a Ohio):
      - número de instancias hoy y el teléfono de cada una (enmascarado en
        el inventario);
      - qué conector tienen (monday: board y columna; Bitrix: entidad y
        campo) y qué plantillas/automatizaciones disparan;
      - volumen de historial: mensajes y conversaciones por instancia;
      - quién en Procesa tiene los teléfonos físicos para escanear QR.
- [ ] **Script de copia de historial** listo y probado en seco (§2.3).
- [ ] **Apps locales de Bitrix** creadas por Procesa en su portal
      (§ alta-cliente, paso 1). Un portal = una app; ocho líneas no exigen
      ocho apps.
- [ ] **Ventana acordada con Procesa**, con la persona de Procesa que
      escanea disponible durante toda la ventana.

---

## 2. Piezas de trabajo del dev (antes de la ventana)

### 2.1 Múltiples números por tenant
Según la decisión de diseño pendiente. Requisito de este plan: cada línea de
WhatsApp de Procesa se activa en su propia línea abierta de Bitrix, o varias
comparten una, según lo que Procesa pida por número.

### 2.2 Playbook de reescaneo con mínima ventana
Ya existe en la plataforma: Sesiones → Conectar número → QR en ~1 min →
escaneo → conectada. Lo que falta es el orden que minimiza el hueco (§3).

### 2.3 `scripts/copiar-historial.mjs` (pendiente de construir)
Copia `tenants/<tOhio>/messages` y
`tenants/<tOhio>/instances/<iOhio>/conversaciones` de la base *default* a
`tenants/<tMx>/…` en la base `factory`, con un **mapa de instancias**
`iOhio → iMx` que se arma conforme se conectan las líneas en México.

Reglas del script, mismas que `migrar-planes.mjs`:
- `--simular` por defecto: cuenta y muestra, no escribe.
- `--aplicar` escribe y registra lo tocado en `migraciones/copia-historial`
  (tenant origen, tenant destino, mapa, conteos, fecha) para poder revertir.
- `--revertir` borra en `factory` exactamente lo que registró; nunca toca
  la base default.
- **Solo lectura sobre Ohio**: el script abre la base default con una
  credencial de solo lectura. No modifica ni borra nada allí.
- Idempotente: los ids de mensaje se conservan; correrlo dos veces no
  duplica.
- Los mensajes copiados conservan su `timestamp` original y su estado; el
  `tenantId`/`instanceId` se reescriben con el mapa. Un mensaje cuya
  instancia no está en el mapa se reporta y no se copia.

Estimación: media jornada de construcción, media de prueba en seco con el
tenant de Digsol como origen ficticio.

---

## 3. Secuencia por línea (el "playbook" de una línea)

Tiempo por línea: **8–12 min**, de los cuales el hueco sin captura de
entrantes es de **3–6 min** (entre la desconexión en Ohio y la conexión en
México). Los mensajes que el contacto mande en ese hueco llegan al teléfono
pero **no quedan en ninguna de las dos bases**.

| # | Dónde | Acción | Confirmación |
|---|---|---|---|
| 1 | México, plataforma | Sesiones → Conectar número. Esperar el QR (~1 min). **No escanear todavía.** | `instancia.crear … resultado=ok`; QR visible |
| 2 | Ohio, consola Cauce | Desconectar la instancia de esa línea (cierra la sesión de WhatsApp en Ohio). *Ohio* solo aquí. | la consola de Cauce la muestra desconectada |
| 3 | Teléfono de Procesa | WhatsApp → Dispositivos vinculados: si "Cauce"/Ohio sigue listado, cerrar sesión ahí. Vincular dispositivo → escanear el QR de México. | plataforma: punto sólido verde; `instancia.estado … a=connected` |
| 4 | México, plataforma | Mensaje de prueba desde el panel de Sesiones al teléfono de control. | `envio.enviado`; en Trazabilidad → Mensajes el estado pasa a entregado |
| 5 | México, plataforma | Recapturar el conector CRM de esa línea (Integraciones → monday o Bitrix, con el token/webhook que Procesa tiene a la mano). Recrear las automatizaciones (plantillas) con la **URL de webhook nueva** y pegarla en el CRM. | `webhook.registrar`; primer disparo de prueba `webhook.recibido` → `envio.enviado` |
| 6 | Bitrix de Procesa | Contact Center: activar el conector en la línea abierta de ese número (§ alta-cliente, paso 4). | `openlines.activacion … linea=N resultado=activo` |
| 7 | Teléfono de control | Mensaje entrante de prueba; un agente responde desde Bitrix. | `openlines.entrante … resultado=ok` y `openlines.operador … resultado=entregado` |
| 8 | Anotar | `iOhio → iMx` en el mapa del script de historial. | — |

Rollback de una línea (si el paso 3 o 4 falla y no se resuelve en 15 min):
eliminar la instancia en México, reconectar la línea en Ohio (QR de Ohio),
verificar que Ohio la ve conectada. El CRM sigue apuntando a los webhooks de
Ohio hasta el paso 5, así que hasta ahí el rollback es solo el QR.

---

## 4. Tandas: no las ocho de golpe

Recomendación: **tres tandas**, no una.

| Tanda | Líneas | Cuándo | Por qué |
|---|---|---|---|
| **1 · piloto** | 1 (la de menor tráfico, acordada con Procesa) | día D, ventana de 30 min | valida el playbook completo con datos reales de Procesa, la RAM medida con su historial, y el flujo del Contact Center con su equipo. Se observa **48 h** antes de seguir |
| **2** | 3–4 | D+2 o D+3, ventana de 60–75 min | ya con el playbook probado. Se observa 24 h |
| **3** | el resto (3–4) | D+3 o D+4, ventana de 60–75 min | cierre |

Razones para no hacer ocho seguidas en una sesión:

1. **Riesgo WhatsApp.** Vincular ocho números nuevos desde una misma IP en
   minutos es un patrón que WhatsApp mira con desconfianza; una tanda de
   3–4 con horas entre tandas reparte ese riesgo. No es un límite
   documentado, es prudencia.
2. **Capacidad medida, no estimada.** Tras la tanda 1 se mide la RAM real de
   una sesión de Procesa (con su historial, que puede pesar más que la de
   pruebas). Si supera lo previsto, se corrige el tamaño de la máquina antes
   de la tanda 2, no a mitad de la 3.
3. **Rollback acotado.** Un problema en la tanda 2 afecta a 3–4 líneas, no
   a ocho, y las de la tanda 1 ya llevan días estables.
4. **La persona que escanea** son ocho vinculaciones con teléfonos que
   pueden estar en manos distintas; 3–4 por sesión es realista.

Dentro de una tanda las líneas se mueven **en serie**, no en paralelo: una
sesión de QR abierta a la vez, para que el hueco por línea sea el del
playbook y no se acumule.

---

## 5. Historial

Después de la **última tanda** (no entre tandas, para que el mapa esté
completo):

1. `node scripts/copiar-historial.mjs --origen <tOhio> --destino <tMx> --mapa mapa.json` (simulación): revisar conteos por instancia contra el inventario del §1.
2. Mau aprueba los conteos.
3. `--aplicar`. Bitácora del script: `migraciones/copia-historial/<fecha>`.
4. Verificar en la plataforma: Trazabilidad → Mensajes muestra el historial
   de Ohio con sus fechas originales, por línea.

Si algo sale mal: `--revertir <id de la corrida>`. Ohio no se tocó.

---

## 6. Ohio después

- Ohio se queda encendida y **sin cambios** al menos **7 días** después de
  la tanda 3, como red de seguridad (rollback = QR de vuelta en Ohio + el
  CRM apuntando a sus webhooks viejos).
- We Build sigue en Ohio hasta que tenga su propio plan de mudanza.
- Apagar los contenedores de Procesa en Ohio (no borrarlos) tras esos 7
  días. Borrarlos, y el tenant de Ohio, es una decisión de Mau aparte, con
  respaldo previo de la base default.

---

## 7. Qué puede salir mal, y qué se hace

| Síntoma | Causa probable | Acción |
|---|---|---|
| El QR de México no aparece en 2 min | RAM insuficiente para el contenedor nuevo | `free -m` en México; no seguir la tanda; redimensionar |
| El teléfono escanea y "conectada" dura segundos | la sesión de Ohio seguía viva y compitió | repetir el paso 2 y cerrar la sesión en Dispositivos vinculados; volver a escanear |
| `openlines.entrante … resultado=omitido motivo="conector sin activar…"` | falta el paso 6 de la línea | activar en Contact Center |
| Disparos del CRM no llegan | el CRM sigue con la URL de webhook de Ohio | pegar la URL nueva en la automatización del CRM |
| Una línea de la tanda no se resuelve en 15 min | — | rollback de esa línea (§3), seguir con las demás, anotar |
| Historial con conteos distintos al inventario | mapa incompleto (línea no anotada en el paso 8) | completar el mapa, `--simular` de nuevo |

---

## 8. Lo que Mau decide antes de fijar fecha

1. Aprobar este plan o pedir cambios.
2. Confirmar tamaño de máquina en México (análisis de capacidad).
3. Aprobar el diseño de múltiples números (análisis enviado aparte).
4. Fecha de la tanda 1 y la persona de Procesa que escanea.
5. Cuenta de Procesa que hará el primer login (provisiona el tenant).
