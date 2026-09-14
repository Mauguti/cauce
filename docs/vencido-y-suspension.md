# Vencido y suspensión: decisión, no código

Decidido con Mau el 14-sep-2026. **No se construye todavía**: primero el
imbot y cerrar el canal abierto. Queda aquí para que, cuando toque, se
construya lo que se decidió y no lo que se recuerde.

## Qué existe hoy

- La fecha de corte del tenant (`cicloCorteEn`) se muestra en Billing y
  solo sirve para aplicar una bajada de plan programada (`planPendiente`).
  Ningún otro código la lee.
- Lo único con dientes es la **prueba**: al vencer `pruebaExpiraEn` el
  tenant pasa a solo lectura, todas las capacidades se apagan, envío y
  bots se detienen, bandeja e historial se ven. Nada se borra.
- No hay "pagado hasta", ni marca de pago, ni recordatorio. El cobro es
  manual (transferencia y factura) y el registro del pago lo hace una
  persona. El único endpoint admin cambia el plan con la llave de admin.

## Lo que se va a construir

### Dato

- `pagadoHasta` en el tenant.
- `diasGracia` por tenant, **default 10**. En cuentas corporativas se
  ajusta a sus términos de pago al firmar (15 o 30 son normales para un
  departamento de pagos). Siete fijos era poco.
- Endpoint admin para registrar el pago (fecha hasta la que queda
  cubierto). Bitácora `pago.registrado`.

### Estado derivado al leer (como hoy solo lectura)

| Estado | Condición |
|---|---|
| al corriente | ahora < `pagadoHasta` |
| vencido | `pagadoHasta` ≤ ahora < `pagadoHasta` + `diasGracia` |
| suspendido | **no se deriva**: lo pone Mau a mano (ver nivel 2) |

Sale en `/api/me`; la plataforma lo pinta.

### Efectos, por nivel

**Nivel 1 · aviso. Automático al corte.**
- Plataforma: banner desde 5 días antes del corte y después de él, con el
  CTA a WhatsApp. Fecha de corte del tenant visible en la tabla de líneas
  del canal abierto (ahí entra el admin del cliente).
- Bitrix (placement y nombre del canal): **nada mientras esté al
  corriente**. Esa pantalla la ven vendedores que no deciden el pago. Solo
  después del corte, un aviso claro; el nombre del canal puede llevar
  "(pago vencido)" y se limpia al registrar el pago.
- Aviso a Mau, simple (correo o similar): "este tenant lleva N días
  vencido", con N contando desde `pagadoHasta`.

**Nivel 2 · suspensión. NO automático.**
- Se dispara con una acción de Mau desde el admin, nunca por reloj. Razón:
  cobro manual + registro manual del pago = tarde o temprano se suspende a
  quien ya pagó porque no se registró. Con Procesa eso es una llamada que
  no queremos.
- Efecto: responder, salientes, automatizaciones y bots apagados con 403;
  bandeja e historial visibles; nada se borra. Reversible al registrar el
  pago.
- **Distinto de solo lectura en una cosa, a propósito: los entrantes se
  siguen espejando a Bitrix.** Si se apagara el espejo, los clientes del
  cliente escribirían y no caería nada en Bitrix; el cliente no se
  enteraría en días, perdería prospectos y la culpa sería nuestra aunque
  no hubiera pagado. Con el entrante llegando y la respuesta bloqueada, el
  dolor es inmediato y visible para la persona correcta, nadie pierde
  prospectos y el cliente puede contestar desde el teléfono mientras
  resuelve el pago. Eso es cobranza; lo otro es sabotaje.
- Se automatiza cuando el registro de pagos lleve meses siendo confiable y
  haya volumen. Hoy no.

**Nivel 3 · líneas apagadas. Solo a mano.**
- Contenedores detenidos, volúmenes intactos; al pagar se levantan sin
  reescanear QR. No se automatiza nunca.

### Lo que no cambia

La **prueba vencida** se queda como está: apaga todo, incluidos los
entrantes. Ahí no hay relación que proteger y no se regala servicio
indefinido.

## Estimación cuando toque

Un día: dato + endpoint admin + estado derivado + aviso a Mau + banners +
aviso en Bitrix + acción de suspender/levantar en el admin, con tests. La
suspensión reutiliza el mecanismo de solo lectura salvo por el espejo de
entrantes, que se deja pasar.
