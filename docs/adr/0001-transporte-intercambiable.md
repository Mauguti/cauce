# ADR 0001 — Transporte intercambiable

**Estado:** aceptada · 2026-09-05

## Contexto

El envío y recepción de mensajes corre sobre una librería no oficial
que reimplementa un protocolo ajeno. Cuando ese protocolo cambia, la
implementación se rompe para toda la flota hasta que haya parche. La
API oficial existe como alternativa, pero obliga a un número nuevo y
el número propio del cliente es la razón principal de compra. El
transporte es, por diseño, la pieza menos confiable del sistema.

## Decisión

Todo canal de mensajería se modela detrás de la interfaz
`MessageTransport` (`packages/transports`): `connect`, `getQr`,
`send`, `disconnect`, `status`. Las implementaciones concretas viven
solo dentro de ese paquete y se obtienen vía `createTransport(tipo)`.
Ningún otro paquete o app importa una implementación concreta.

Hoy existe únicamente `MockTransport`, que simula el ciclo completo en
memoria. La implementación real se agrega después sin tocar a los
consumidores.

## Consecuencias

- Cambiar de librería, o caer a la API oficial, es escribir una
  implementación nueva y registrarla en el factory; el resto del
  sistema no se entera.
- El tipo de transporte es un dato por instancia (`transportType`),
  así que la flota puede migrar de forma gradual, tenant por tenant.
- Todo el desarrollo y las pruebas corren contra el mock, sin red ni
  sesiones reales.
- Costo asumido: una capa de indirección y la disciplina de no
  filtrar detalles del transporte (formatos de id, errores crudos)
  hacia arriba.
