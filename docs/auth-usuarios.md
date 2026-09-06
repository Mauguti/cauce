# Autenticación de usuarios (pendiente — no implementado)

Hoy la consola y las integraciones se autentican con **una API key por
tenant** (ver ADR 0002). Es suficiente para operar un tenant propio,
que es el caso actual (We Build). Este documento describe cómo se
añadiría login de usuarios con Firebase Auth, para no empezarlo a
medias.

## Objetivo

Que las personas entren a la consola con su cuenta (Google / correo),
y que el `tenantId` se derive del usuario autenticado — no de una key
pegada en un campo. La API key queda **solo** para integraciones
máquina a máquina (p. ej. scripts), no para la consola.

## Diseño propuesto

1. **Firebase Auth en la consola.** Login con el SDK de Firebase (el
   proyecto `cauce-consola` ya existe). La consola obtiene un **ID
   token** (JWT de Firebase) y lo manda en `Authorization: Bearer`
   en cada llamada al orquestador, en lugar de `x-api-key`.

2. **Verificación en el orquestador.** Un middleware verifica el ID
   token con el Admin SDK de Firebase (`verifyIdToken`), obtiene el
   `uid`, y resuelve el `tenantId`:
   - Opción simple: un **custom claim** `tenantId` en el usuario,
     asignado al darlo de alta (`setCustomUserClaims`). El tenant sale
     del claim, igual que hoy sale de la key. Cero lecturas extra.
   - Opción con tabla: colección `usuarios/{uid} → { tenantId, rol }`
     en Firestore, si un usuario puede pertenecer a varios tenants.

3. **Convivencia con la API key.** El middleware `autenticar` acepta
   dos credenciales: si viene un ID token de Firebase válido, deriva el
   tenant de ahí; si viene `x-api-key`, el flujo actual. Así las
   integraciones no se rompen.

4. **Alta de usuarios.** Endpoint (o script) que crea el usuario en
   Firebase Auth y le fija el claim `tenantId`. Fuera del alcance de la
   consola por ahora.

## Por qué se pospone

- La API key ya cubre el único tenant en producción; el login no
  desbloquea ningún caso de uso pendiente.
- Hacerlo a medias (login en la consola sin verificación real en el
  orquestador, o sin resolver multi-tenant) dejaría un agujero de
  seguridad peor que el estado actual.
- Toca auth en consola **y** orquestador a la vez; conviene un bloque
  propio con su prueba de "usuario del tenant A no ve datos del B".

## TODO al retomarlo

- [ ] `firebase` SDK en la consola + pantalla de login.
- [ ] Admin SDK en el orquestador; `verifyIdToken` en `autenticar`.
- [ ] Custom claim `tenantId` y flujo de alta de usuarios.
- [ ] Prueba: token de usuario del tenant A → 401/404 sobre recursos
      del tenant B (equivalente a la que ya existe para API keys).
