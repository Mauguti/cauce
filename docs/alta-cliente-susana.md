# Alta de un cliente con Susana (citas sobre Google Calendar)

Paso a paso como lo ejecuta Mau con el cliente enfrente. Tiempo: 20 min.
Todo desde la plataforma; nada exige desplegar ni reiniciar.

**Regla de secretos.** Las credenciales de la app OAuth de Google
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) viven en `/etc/factory.env`
del orquestador. El cliente nunca captura nada de eso; solo aprieta
"Permitir" en su propia cuenta de Google.

## 0. Antes de la cita con el cliente

- [ ] **Sector permitido.** Talleres mecánicos, estéticas, estudios de
      masaje. ⛔ Nada de salud (consultorios, dentistas, psicólogos): sin
      aviso de privacidad no se vende Susana ahí. Si preguntan: "Todavía no
      atendemos consultorios; los motivos de cita médica son datos
      sensibles y estamos preparando el aviso de privacidad".
- [ ] **Orquestador con Google configurado.** `GET /health` devuelve
      `google: true`. Si es `false`, faltan las variables (ver
      docs/deploy.md).
- [ ] **App de Google:** redirect URI registrado exactamente como
      `https://api.factory.digsol.com.mx/google/callback`; el correo del
      cliente agregado como **usuario de prueba** mientras la app siga sin
      verificar (tope 100).
- [ ] Tenant en plan **Pro** (Susana es un agente) y una línea de WhatsApp
      conectada.

## 1. Conectar Google Calendar (con el cliente)

Integraciones → Google Calendar → **Conectar Google**. Se abre la pantalla
de Google del negocio.

**Mientras la app no esté verificada aparece esta pantalla: "Google no ha
verificado esta aplicación".** No dejes que el cliente se la encuentre
solo. Antes de que aparezca, Mau dice, palabra por palabra:

> "Ahora Google te va a mostrar un aviso de que la aplicación está en
> revisión. Es el proceso normal de Google para apps nuevas: ya enviamos
> la solicitud y tarda unas semanas. Lo que estás autorizando es solo que
> Digsol Factory pueda leer y escribir eventos en tu calendario; no
> tocamos tu correo ni tus contactos. Puedes quitar el permiso cuando
> quieras desde tu cuenta de Google. Dale a 'Avanzado' y luego a 'Ir a
> Digsol Factory'."

Después Google pide el permiso de eventos → **Permitir**. Vuelve a
Integraciones con "Google Calendar conectado (correo)". Bitácora:
`google.conectado tenant=… email=…`.

Si el cliente dice "no" (`google=denegado`), no se insiste ahí: se anota y
se vuelve cuando la app esté verificada.

## 2. Horario, duración y calendario

En el mismo panel: días que se atienden, desde/hasta, duración de la
cita. Calendario: `primary` (el principal de la cuenta conectada) o el id
de otro calendario de esa cuenta. Bitácora: `agenda.configurada`.

## 3. Directorio

Agregar al dueño (rol dueño/admin) y a cada profesional con su número.
Si un profesional tiene su propio calendario en la misma cuenta, su id
(normalmente su correo) en "Calendario". Todo número que no esté aquí es
cliente.

## 4. Activar a Susana

Admin (Mau, con `CAUCE_ADMIN_KEY`):

```
POST /api/admin/tenants/<tenant>/agente
{"nombre":"Susana","rol":"citas","modelo":"<modelo>","activo":true}
```

Gestión de Agentes muestra "Susana · Citas · Operando".

## 5. Prueba desde el celular de Mau (10 min)

1. Con el número de Mau en el directorio como dueño: escribir **"modo
   cliente"** → responde que atiende como cliente 2 horas.
2. "Quiero una cita el sábado" → ofrece horas del calendario, en la zona
   del calendario. Comprobar contra Google Calendar que son horas libres.
3. Elegir una → pide confirmación con la frase exacta → "sí" → "quedó el
   sáb … a las …". El evento aparece en Google como "Cita · <nombre>".
   Bitácora: `cita.propuesta` y `cita.agendada … quien=… telefono=…`.
4. "Cancela mi cita" → pide confirmación → "sí" → desaparece del
   calendario. Bitácora `cita.cancelada`.
5. **"salir de modo cliente"** → "qué tengo mañana" → lista con hora y
   nombre de pila. Confirmar que un evento ajeno sale como "ocupado".
6. "Cancela todas mis citas de mañana" → traspaso a humano, no cancela.
7. Prueba de empalme (opcional, con dos celulares): proponer la misma
   hora desde los dos y confirmar casi a la vez: uno queda, el otro recibe
   otras horas. Bitácora `cita.franja_tomada` o `cita.ocupada_al_confirmar`.

## 6. Qué vigilar el primer mes

- `cita.empalme`: más de una vez por semana en un cliente = algo está mal
  (alguien agenda a mano sobre las horas ofrecidas o el calendario no es
  el correcto). Cero en tres meses = se sobre-diseñó; también se anota.
- `google.token_error invalid_grant`: el cliente revocó el permiso;
  reconectar desde Integraciones.
- Quejas de "me dijo las 3 y era a las 2": revisar la zona horaria del
  calendario en Google (Configuración → zona horaria), no el servidor.
