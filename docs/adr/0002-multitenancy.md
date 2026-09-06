# ADR 0002 — Multitenancy desde el primer commit

**Estado:** aceptada · 2026-09-05

## Contexto

El producto es multi-cliente por definición: cada empresa conecta su
número y sus datos no pueden cruzarse con los de nadie más. Hoy existe
un solo tenant (cliente cero), y la tentación es dejar el aislamiento
"para después". Meter multitenancy sobre un sistema mono-tenant es
rehacer el modelo de datos, las rutas y las consultas.

## Decisión

- Todo dato lleva `tenantId`. Los tipos de `packages/core` lo cargan
  explícito y las colecciones de Firestore son subcolecciones de
  `tenants/{tenantId}` — el aislamiento es estructural, no un filtro
  opcional.
- Las rutas de Firestore se construyen solo con los helpers `rutas` de
  `@cauce/core`, que exigen el `tenantId` como argumento.
- Toda ruta HTTP de datos cuelga de `/api/tenants/:tenantId` y pasa
  por un middleware que valida el tenant y lo fija en la request.
- El repositorio (`Repositorio` en el orquestador) no ofrece ninguna
  operación sin `tenantId`.

## Consecuencias

- Dar de alta al segundo cliente es crear un documento, no un
  proyecto de refactor.
- No existe una consulta "global" accidental: la forma de los datos y
  de las APIs la hace imposible de escribir.
- Pendiente explícito: hoy el `tenantId` viene del path porque no hay
  autenticación (fuera de alcance). Con auth real, se deriva de la
  identidad y el path solo se verifica contra ella.
