# Renombrado a Digsol Factory — qué se renombró y qué quedó (deuda)

El producto pasó a llamarse **Digsol Factory** (la fábrica de empleados
digitales). El renombrado tocó solo lo **visible para el usuario**; los
identificadores internos siguen diciendo `cauce` a propósito.

## Renombrado (visible al usuario)

- Consola: títulos, marca en el nav, textos de onboarding (Expectativas),
  cuenta, errores ("Sin conexión con Digsol Factory…"), modales.
- `apps/console/index.html` `<title>`.
- README y `docs/` (prosa del nombre del producto).
- Nombre del dispositivo en WhatsApp → Dispositivos vinculados
  (`CONFIG_SESSION_PHONE_CLIENT`), que el cliente ve en su teléfono. Solo
  afecta **sesiones nuevas**; no es el nombre de instancia.

## Lo que NO se renombró (y por qué) — deuda con plan

| Qué | Por qué se queda | Plan de migración futura |
|---|---|---|
| **Nombre de instancia de Evolution** `cauce-{tenant}-{instance}` | Registrado dentro de contenedores vivos, en nombres de volúmenes (`cauce-auth-*`) y en Dispositivos vinculados del teléfono del cliente. Cambiarlo rompe la rehidratación de sesiones vivas. | Migrar solo al recrear una instancia: nuevas instancias podrían usar `factory-{tenant}-{instance}` con un mapa de compatibilidad que reconozca ambos prefijos al rehidratar. Nunca renombrar en caliente. |
| **Variables de entorno** `CAUCE_API_KEY`, `CAUCE_CRYPTO_KEY`, `CAUCE_VERSION`, `CAUCE_*` | Viven en `/etc/cauce.env` en la EC2; renombrarlas exige coordinar el despliegue (leer ambos nombres durante la transición). | Introducir lectura dual (`FACTORY_*` con fallback a `CAUCE_*`), desplegar, migrar el env file, y quitar el fallback en un release posterior. |
| **Rutas de API y URLs de webhook** (`/webhooks/monday/…`, `/webhooks/bitrix/…`, `/api/tenants/…`) | Los clientes ya las pegaron en sus automatizaciones de monday y Bitrix. Cambiarlas las rompe. | Mantener las rutas actuales indefinidamente; si algún día se agregan alias, servir ambas. |
| **Paquetes internos** `@cauce/core`, `@cauce/orchestrator`, `@cauce/console`, `@cauce/transports` | Nombre interno del monorepo; no lo ve el usuario. Renombrar es ruido de imports sin valor de cara al cliente. | Opcional y de baja prioridad; solo si molesta al equipo. |
| **Dominios e infra** `cauce.digsol.com.mx`, proyecto Firebase `cauce-consola` (`cauce-consola.web.app`), red Docker `cauce-net`, Postgres `cauce-db`, `/opt/cauce` | DNS/hosting/infra en producción; cambiarlos es una migración de infraestructura con downtime. | Diferido; se puede montar el nuevo dominio (`factory.digsol.com.mx`) como alias apuntando al mismo servicio cuando se quiera, sin tocar el resto. |

Regla general: el **producto** se llama Digsol Factory; el **código y la
infra** siguen bajo el nombre clave `cauce` hasta que haya una ventana de
despliegue para migrarlos sin romper producción.
