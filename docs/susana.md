# Susana v1: agenda de citas sobre Google Calendar

Decidido el 16-sep-2026 con Mau. Construido en el orquestador
(`agentes/citas.ts`, `google/calendario.ts`, `google/tiempo.ts`) y en la
plataforma (Integraciones → Google Calendar, panel de agenda y directorio).
Abre el mercado que no tiene CRM: WhatsApp y calendario. Sectores de
entrada: talleres mecánicos, estéticas y estudios de masaje.

## Alcance (los recortes quitan riesgo, no solo tiempo)

- **Solo Google Calendar.** Outlook, Apple y Calendly cuando un cliente
  que paga lo pida.
- **Sin pagos.** Ni cobro, ni ligas, ni anticipos.
- **Sin acciones masivas.** "Cancela todas mis citas de mañana" dispara
  `pasar_a_humano`. No existe el tercer nivel de confirmación.
- **Privacidad, un solo comportamiento.** Hora y nombre de pila; nunca el
  motivo ni datos de terceros. Sin interruptor: si un cliente lo pide, se
  agrega y queda asentado que lo pidió.
- ⛔ **Nada de salud** (dentistas, psicólogos, consultorios) hasta que
  exista el aviso de privacidad: los motivos de cita médica son datos
  personales sensibles bajo la LFPDPPP. El CV lo dice.

## Cómo se conecta Google: OAuth por tenant

| Opción | Por qué no / por qué sí |
|---|---|
| **OAuth por tenant (elegida)** | Sirve para Gmail personal y Workspace; un clic en Integraciones; refresh token cifrado por tenant (`conectores/google`); revocable por el cliente desde su cuenta de Google o desde la plataforma. |
| Cuenta de servicio con delegación | Solo Workspace: excluye Gmail personal, que es justo el taller y la estética. |
| Compartir calendarios con una cuenta nuestra | Un solo secreto que compromete a todos los clientes. Descartado. |

Scope mínimo: `calendar.events` (leer y escribir eventos). Con eso se
lista, se inserta, se mueve, se borra y se obtiene la zona horaria del
calendario (viene en `events.list`). No se pide `calendar` completo.
Además `userinfo.email` solo para mostrar qué cuenta quedó conectada.

Mientras la app de Google esté **sin verificar**, el cliente ve la
pantalla "Google no ha verificado esta aplicación" al conectar. Eso va en
el procedimiento de alta (`docs/alta-cliente-susana.md`) con la frase que
Mau dice; no se deja que se lo encuentre enfrente de un cliente. Hasta 100
usuarios de prueba mientras dura la verificación.

## Directorio mínimo, a nivel tenant

`tenants/{t}/directorio/{digitos}`: número → persona → rol (dueño/admin ·
profesional · recepción) → su calendario (opcional; sin él, el calendario
por defecto del tenant). **Todo número fuera del directorio es cliente.**
Vive en el tenant, no en el ADN de Susana: todos los agentes consumen la
misma lista.

Comando por chat para un número del directorio: **"modo cliente"** (2 h)
y **"salir de modo cliente"**; no pasa por el modelo. También desde el
panel de agenda. Sin esto Mau no puede demostrar el flujo desde su celular.

## Dos niveles de confirmación, en código

- **Consulta** (`consultar_disponibilidad`, `consultar_citas`): basta
  reconocer el número. Un cliente ve solo sus citas; el equipo, las de su
  agenda (hora y nombre de pila; eventos ajenos al sistema salen como
  "ocupado").
- **Cambio puntual** (agendar, cancelar o mover UNA cita):
  `proponer_cambio` valida y deja la propuesta en la conversación
  (`citaPendiente`) sin escribir nada; `confirmar_cambio` solo la ejecuta
  si la llamada viene en un **mensaje posterior** del cliente. Así la
  confirmación es del cliente, no una palabra que el modelo se dice a sí
  mismo. Bitácora: `cita.propuesta` → `cita.agendada|cancelada|movida`.
- **Masivo**: no existe. Traspaso a humano.

## Anti-empalme: tres capas, y Susana cede

1. **Relectura justo antes de escribir**, no antes de preguntar. La hora
   ofrecida sale del calendario en el momento de la propuesta; la verdad
   se vuelve a leer cuando el cliente confirma, milisegundos antes del
   `insert`.
2. **Candado atómico en nuestro lado** (`reservas/{calendario|inicio}`,
   transacción, vigencia 2 min): dos conversaciones nuestras por la misma
   hora no pasan las dos. La segunda recibe "esa hora se acaba de
   ocupar, tengo estas dos".
3. **Verificación posterior.** Google no impide dos eventos a la misma
   hora. Tras el `insert` se lee la franja otra vez; si hay un evento que
   no es el nuestro, alguien agendó a mano en la ventana. **Susana cede:**
   borra su evento (o regresa la cita movida a su hora original), pide
   una disculpa breve y ofrece las siguientes horas. Bitácora
   `cita.empalme … resultado=cedido` (nivel error).

**Por qué cede, aunque sea contraintuitivo:** un mensaje incómodo al
cliente cuesta infinitamente menos que dos personas presentándose a la
misma cita. Nunca empalmar a un profesional vale más que nunca desdecirse
con un cliente. El ajuste por tenant para que gane Susana se agrega cuando
alguien lo pida.

**Qué esperar de `cita.empalme`.** La ventana es de milisegundos: casi
nunca debería salir. Si sale más de una vez por semana en un cliente,
algo más está mal (alguien agenda a mano sobre las horas que Susana
ofrece, o el calendario no es el que se cree) y hay que enterarse. Si en
tres meses no sale nunca, se sobre-diseñó y también está bien saberlo.

Fuera a propósito: notificaciones push de Google. Exigen endpoint público
con renovación semanal y no quitan la carrera; la relectura la cubre con
menos piezas.

## Zonas horarias

Susana lee y escribe **siempre en la zona que declara el calendario**
(`events.list` → `timeZone`), nunca en la del servidor ni asumiendo
México central. Querétaro es UTC−6 sin horario de verano; Baja California
cambia. `google/tiempo.ts` convierte fecha y hora locales a instantes y
de vuelta con `Intl`; hay prueba con un calendario en `America/Tijuana`
(la misma hora local es otro instante, y cambia entre verano e invierno).
El prompt le dice al modelo la hora local y la zona; la disponibilidad se
presenta en horas locales; el evento se escribe en UTC.

## Configuración del tenant

`tenant.agenda`: calendario por defecto (`primary`), duración (60 min),
horario (lun–vie 09:00–18:00), anticipación mínima (120 min) y ventana
(14 días). Se edita en Integraciones → Google Calendar. El agente se
activa por admin con `rol: "citas"`:

```
POST /api/admin/tenants/:t/agente  {"nombre":"Susana","rol":"citas","modelo":"…"}
```

Sin Google conectado, Susana no contesta y lo dice
(`agente.sin_calendario`). El plan debe incluir `agentes` (Pro).

## Bitácora

`cita.disponibilidad`, `cita.consulta`, `cita.propuesta`,
`cita.agendada`, `cita.cancelada`, `cita.movida`, `cita.empalme`,
`cita.franja_tomada`, `cita.ocupada_al_confirmar`, `directorio.*`,
`agenda.configurada`, `google.conectado|desconectado|oauth_error|token_error|api_error`.
Toda acción sobre el calendario lleva `quien=<nombre> telefono=<enmascarado> rol=<cliente|dueno|profesional|recepcion>`.

## No construido a propósito (v1)

Recordatorios de cita, lista de espera, varios locales, política de
cancelación con penalización, cobro de anticipos, Outlook/Apple/Calendly,
interruptor de privacidad por tenant, "gana Susana" en empalmes.
