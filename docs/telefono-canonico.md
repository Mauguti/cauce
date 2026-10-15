# Teléfono canónico como llave de conversación

Decidido el 15-oct-2026 tras el hallazgo en el CSV de We Build: los
salientes del CRM salían como `+52` + 10 dígitos y las respuestas de
WhatsApp llegaban como `+521` + 10 (el JID mexicano). Cero coincidencias
entre direcciones, 17 terminaciones repetidas: la misma persona como dos
contactos. Efectos: tasa de respuesta 0 % (real ≥ 35 %), hilos partidos,
y "primer contacto" cuando respondía alguien a quien ya se le escribió. Le
pasa a todo tenant que dispara desde el CRM: We Build, Procesa, GeoSpectral.

## La regla

- **Se guarda como viene, se identifica canonizado.** El mensaje conserva el
  teléfono que trajo (`+52…` del CRM, `+521…` de WhatsApp). La llave de la
  conversación, del chat del Contact Center, del directorio y del id de
  consumo es `telefonoCanonico(telefono, pais)` de `@cauce/core`.
- **Canónica = forma del JID de WhatsApp, por país.** México: `521` + 10
  dígitos. Se eligió esa y no la de `+52` porque los chats del Contact
  Center de Bitrix ya se identifican así y no los controlamos: la
  migración no toca Bitrix.
- **La regla recibe el país.** Hoy solo México tiene regla (el "1" de móvil
  tras el 52). Estados Unidos y cualquier otro: dígitos tal cual; nunca se
  mete un 1. `pais` solo decide cómo completar la lada cuando el CRM guardó
  el número sin ella (10 dígitos con `MX` → `52…`). Viene de
  `Tenant.pais` (default `MX`).
- **Primer contacto ≠ primer entrante.** Si el CRM ya le escribió (hay
  item o entidad vinculada), la respuesta no es primer contacto: no hay
  bienvenida. La atribución de campaña sí se captura al primer entrante.
- Los mensajes se consultan por todas las formas equivalentes
  (`formasEquivalentes`): el hilo trae el saliente `+52` y la respuesta `+521`.

## Orden de salida, no negociable

1. **Código a producción** (`telefonoCanonico` en todas las llaves). Detiene
   la sangría: desde ese momento, salientes y respuestas caen en la misma
   conversación.
2. **Reporte** con `scripts/migrar-conversaciones-canonicas.mjs` (sin
   bandera): cuántas partidas hay y cuántas son seguras.
3. **`--aplicar`** solo para la categoría segura (a lo sumo un doc con
   entrantes, vínculos al CRM sin contradicción, sin traspaso abierto ni
   cita pendiente ni ventana humana viva ni chat de Bitrix duplicado).
   Deja respaldo JSON; `--revertir <json>` lo deshace. Lo demás queda
   listado en el respaldo para decidir a mano.

Si se migra antes del código, el código viejo vuelve a partirlas.
