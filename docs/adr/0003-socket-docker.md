# ADR 0003 — Acceso al socket de Docker

**Estado:** aceptada · 2026-09-05

## Contexto

El orquestador crea y destruye contenedores de sesión vía dockerode,
que habla con el socket de Docker. Montar `/var/run/docker.sock`
dentro de un contenedor equivale a dar root del host: cualquier
compromiso del orquestador containerizado sería compromiso total de
la máquina.

Además hay una limitación de red: el DNS interno de Docker (resolver
`cauce-{tenant}-{instance}` por nombre) solo funciona entre
contenedores de la misma red, no desde procesos del host. Un
orquestador en el host no puede usar los hostnames de `cauce-net`.

## Decisión

En esta fase el orquestador corre **directo en el host**, no
containerizado. Consecuencias operativas de esa decisión:

- El socket se usa desde el host con los permisos del usuario que
  corre el proceso; no se monta en ningún contenedor.
- Como el host no resuelve hostnames de `cauce-net`, cada contenedor
  de sesión publica su puerto 8080 **solo en loopback**
  (`127.0.0.1:puerto-efímero`). Nada queda accesible desde fuera de
  la máquina; Caddy publica únicamente al orquestador.
- Los hostnames `cauce-{tenant}-{instance}` siguen siendo el
  mecanismo de resolución **entre contenedores** (p. ej. instancia →
  `cauce-db`), y quedan listos para el escenario containerizado.

## Alternativa productiva pospuesta

Containerizar el orquestador detrás de un **proxy de socket con
allowlist** (p. ej. un socket-proxy que solo permita
`POST /containers/create`, `start`, `stop`, `remove`, `inspect`,
`GET /networks`, y niegue `exec`, `build` y el resto). Con el
orquestador dentro de `cauce-net`, hablaría a las instancias por
hostname sin puertos loopback, y el radio de daño de un compromiso
queda acotado a los endpoints de la allowlist.

Se pospone porque: (1) agrega una pieza más que operar antes de tener
el ciclo básico probado, (2) la allowlist hay que diseñarla contra el
uso real del orquestador, que apenas se está definiendo, y (3) el
`docker exec` que hoy usamos para administrar Postgres no pasaría por
la allowlist y primero hay que sustituirlo por conexión SQL directa.

## Consecuencias

- El orquestador es un proceso systemd/pm2 en el host EC2, no un
  contenedor. Su despliegue se documenta aparte.
- Quien comprometa al orquestador tiene el socket completo. Mitiga:
  es el único servicio expuesto y no ejecuta código de terceros.
- Cuando llegue el proxy de socket, el único cambio en código es la
  URL del daemon en `DockerManager` y eliminar los bindings loopback.
