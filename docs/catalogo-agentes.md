# Catálogo de agentes: roster, estado y decisiones

Cerrado el 15-sep-2026 con Mau y el PM. Una sola fuente de nombres y roles
en la plataforma: `constants.ts` (`AGENTS`); toda pantalla lee de ahí.

## Roster

| Agente | Rol | Estado |
|---|---|---|
| Santiago | Ventas y perfilamiento | **En operación** |
| Mateo | Marketing y campañas | Mapeado, no construido |
| Elena | Cobranza | Mapeada, no construida |
| Valeria | Soporte | Mapeada, no construida |
| Susana | Citas y recepción | **En operación (v1, 16-sep-2026)**: talleres, estéticas, masaje; no salud |
| Emilio | Cuentas por pagar | Mapeado, no construido |

Descartado: agente de pedidos para restaurantes. Exige catálogo con
disponibilidad, punto de venta, logística de entrega y audio. Es otro
producto, no un agente.

## Línea roja: no somos la API oficial de WhatsApp

Ninguna pantalla puede afirmar "WhatsApp Business API". El CV de Santiago
lo decía como certificación; ahora la sección se llama **Integraciones** y
lista solo lo que existe: "WhatsApp por sesión vinculada (no es la API
oficial de Meta)", Bitrix24 y monday; el resto "Próximamente", mismo
criterio que la plataforma. Los agentes no construidos dicen
**Próximamente** en la ficha, el CV y el botón de contratar.

## Por qué no se construye ninguno más todavía

**Santiago nunca ha tenido una conversación validada con un cliente de
paga.** Seis agentes sobre una base sin comprobar es trabajo que después
se rehace. Cuando Santiago pase su prueba y tenga un cliente de paga
encima, se abre el segundo. No antes.

## Decisiones ya tomadas, para no perderlas

### Directorio de usuarios y roles: a nivel tenant

- Va en el **tenant**, no dentro del ADN de cada agente. Susana, Emilio y
  Santiago consumen la misma lista; duplicarla garantiza que se
  desincronice y que una baja quede viva en un agente.
- Mapea número → persona → su recurso (agenda, cartera, equipo). En un
  consultorio con cuatro dentistas, "mis citas" significa las de él.
- Roles: dueño/admin · profesional · recepción · cliente (fuera del
  directorio: todo lo demás).
- Tres niveles de confirmación según el daño:
  - consulta → basta reconocer el número;
  - cambio puntual → confirmación en el chat;
  - masivo o destructivo → el agente responde con el conteo y las
    consecuencias y exige confirmación explícita; nunca a la primera frase.
- Toda acción a bitácora con nombre y número: "¿quién canceló?" sale el
  primer mes.
- Interruptor de privacidad por tenant: por default el agente devuelve
  hora y nombre de pila, sin el motivo de la cita; el detalle completo se
  enciende solo si el cliente lo pide y queda asentado.
- Comando para que un número del directorio pase a modo cliente temporal:
  sin eso no se puede demostrar el flujo desde el celular de Mau.

### Emilio no es un agente de OCR

- En México la factura es CFDI y llega como XML: parsearlo es
  determinista (UUID, RFCs, subtotal, IVA, total, forma y método de pago,
  uso de CFDI). El OCR solo aplica a lo que no es CFDI: tickets, casetas,
  notas de taxi, comprobantes extranjeros.
- Diferenciador y argumento de venta: validación contra el web service
  público del SAT (vigente vs cancelado) y contra la lista 69-B (EFOS).
- Obligatorio **archivar el XML**, no solo extraer campos. Sin XML no hay
  deducción. El UUID resuelve duplicados sin heurísticas.
- Dos modos; se arranca por el segundo: (A) el cliente pide su factura →
  después; (B) el empleado manda su gasto o viático → se extrae,
  clasifica y carga a monday, Sheets o el sistema del cliente. Usuarios
  internos, sin exposición a desconocidos, dolor mensual garantizado.
- **Línea roja: Emilio informa, no asesora.** Decir "no deduzcas esto" es
  asesoría fiscal y está prohibido. Avisa el estado ante el SAT y la lista
  69-B; la decisión es del contador.

### Susana v1 (decidido 16-sep-2026: se construye ahora, versión corta)

Abre el mercado que hoy no se puede vender: WhatsApp y calendario sin CRM.
KPI de venta: tasa de no-show. Cada recorte quita riesgo, no solo tiempo:

- **Solo Google Calendar.** Outlook, Apple y Calendly cuando un cliente
  que paga lo pida.
- **Sin pagos.** Ni cobro, ni ligas, ni anticipos: otra conversación, con
  implicaciones regulatorias.
- **Sin acciones masivas.** "Cancela todas mis citas de mañana" no se
  ejecuta: dispara `pasar_a_humano`. Con eso desaparece el tercer nivel de
  confirmación, el más peligroso y el más caro.
- **Privacidad, un solo comportamiento.** Devuelve hora y nombre de pila,
  nunca el motivo. Sin interruptor: el default seguro es el único modo. Se
  agrega si un cliente lo pide y queda asentado que lo pidió.
- **Directorio mínimo, a nivel tenant** (no en el ADN): número → persona →
  rol (dueño/admin · profesional · recepción) → su calendario. Todo número
  fuera del directorio es cliente. Comando para que un número del
  directorio pase a modo cliente temporal (demo desde el celular de Mau).
- **Dos niveles de confirmación:** consulta → basta reconocer el número;
  cambio puntual (agendar, cancelar, mover UNA cita) → confirmación en el
  chat antes de escribir; masivo → no existe, traspaso a humano.
- **Bitácora con nombre y número** en toda acción sobre el calendario.
- ⛔ **Nada de salud** (dentistas, psicólogos, consultorios) hasta que
  exista el aviso de privacidad: los motivos de cita médica son datos
  personales sensibles bajo la LFPDPPP. Sectores de entrada: talleres
  mecánicos, estéticas y estudios de masaje. El CV y el material lo dicen.

Decidido y construido (16-sep-2026): OAuth por tenant con scope
`calendar.events`; empalmes en tres capas y **Susana cede**. Diseño
completo en `docs/susana.md`; alta en `docs/alta-cliente-susana.md` (con
la frase para la pantalla de "app no verificada" de Google).

### Trazabilidad de campañas: capa base, no agente

Ver `docs/atribucion-campanas.md`. La captura y etiquetado del origen va
en el plan de conexión para todos los planes; Mateo solo lee y reporta.

### Recepción de adjuntos

Sube de prioridad: es la pieza de plataforma con más palanca (Emilio,
inmobiliario, restaurantes). Reglas ya decididas: retención 30 días / 6
meses / 12 meses por plan, 20 MB por archivo, tope por cuenta con borrado
del más antiguo primero. Costo en `docs/adjuntos.md` cuando lleguen las
cuatro líneas de las sondas.
