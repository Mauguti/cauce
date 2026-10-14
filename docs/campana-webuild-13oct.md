# Campaña de cobranza de We Build · 13-oct-2026: métricas

**Estado: PENDIENTE DE CORRER.** Los números de abajo salen de un extractor
de solo lectura contra Firestore y de dos comandos sobre el journal de la
EC2; ninguno se puede correr desde la Mac del desarrollador (sin acceso a
la EC2 ni al proyecto de Firestore). Mau los corre y pega la salida aquí.
**Nada se estima.** Lo que no se pueda reconstruir se marca así.

**Regla dura:** ningún teléfono ni nombre de contacto en este documento ni
en la salida de los comandos. El extractor cuenta contactos por un hash
interno que nunca imprime; los comandos del journal solo sacan
timestamps y conteos. Esto termina en material comercial.

## 1. Cómo se obtienen (repetible con la siguiente campaña)

### 1.1 Firestore: salientes, contactos, estado final, respuestas, cola, agente

En la EC2, sin tocar el checkout de producción (misma técnica que
`tenants-estado.mjs`): copiar el script dentro del árbol del orquestador
con otro nombre, correrlo con las variables de `/etc/factory.env`, borrarlo.

```bash
cd /opt/factory && git fetch --quiet origin feature/espejo-telefono-revisar && git show origin/feature/espejo-telefono-revisar:scripts/campana-metricas.mjs > apps/orchestrator/_campana-metricas-tmp.mjs && node --check apps/orchestrator/_campana-metricas-tmp.mjs && echo "sintaxis ok"
```

```bash
sudo bash -c 'set -a; . /etc/factory.env; set +a; cd /opt/factory/apps/orchestrator && node _campana-metricas-tmp.mjs --tenant <TENANT_WEBUILD> --desde 2026-10-13T00:00:00-06:00 --hasta 2026-10-14T00:00:00-06:00 --origen crm'
```

```bash
cd /opt/factory && rm apps/orchestrator/_campana-metricas-tmp.mjs && git status --short | head -3
```

Qué significa cada parámetro: `--tenant` es el id del tenant de We Build
(sale en `tenants-estado.mjs`); `--desde/--hasta` la ventana en hora local
(`-06:00` Querétaro); `--origen crm` cuenta solo los salientes disparados
por el conector de monday (los manuales llevan `manual`). Con `--origen
todos` entran todos. `--respuestas-horas 72` (default) es hasta cuántas
horas después del primer saliente se cuenta una respuesta.

Qué mide: total de salientes y su ventana real (primero, último), líneas,
contactos distintos, estado final (confirmado por WhatsApp / enviado sin
confirmación aún / sin confirmar / fallido / encolado) con motivos de fallo
(`errorCodigo`), vaciado de la cola (del primer encolado a la última
confirmación), contactos que contestaron y minutos hasta responder
(mediana, p90, máximo), y llamadas y costo del agente en USD y pesos.

### 1.2 Journal: hora exacta de cada envío y cuánto tardó la cola

El extractor usa la confirmación de WhatsApp (`confirmadoEn`); la hora
exacta en que el orquestador entregó cada mensaje está en `envio.enviado`.
Solo timestamps y conteos; sin campos de teléfono:

```bash
journalctl -u factory --since "2026-10-13 00:00" --until "2026-10-14 00:00" -o cat | grep -E "^[0-9T:.Z-]+ info envio.enviado " | awk '{print $1, $4}' | sort | awk 'NR==1{print "primer envio:", $0} {ult=$0; n++} END{print "ultimo envio:", ult; print "total envio.enviado:", n}'
```

```bash
journalctl -u factory --since "2026-10-13 00:00" --until "2026-10-14 00:00" -o cat | grep -E " (envio.fallido|envio.reintento|entrada.monday|monday.rechazado) " | awk '{print $3}' | sort | uniq -c
```

El primero imprime el primer y el último `envio.enviado` del día (con su
instancia) y el total: la diferencia es cuánto tardó la cola en vaciarse
de principio a fin. El segundo cuenta fallos, reintentos, disparos del
conector y rechazos, sin más campos.

**Si el journal ya rotó** (el arranque solo guarda unos días en una
`t3.small`), `journalctl --since` devuelve vacío: ese dato se pierde y se
queda con la confirmación de WhatsApp del extractor, que sí persiste.

## 2. Resultados

> Pendiente. Pegar aquí la salida completa del extractor (1.1) y de los dos
> comandos del journal (1.2), tal cual.

| Métrica | Valor | Fuente |
|---|---|---|
| Salientes de campaña | pendiente | 1.1 `salientes.total` |
| Ventana (primero → último encolado) | pendiente | 1.1 |
| Líneas | pendiente | 1.1 `lineas` |
| Contactos distintos | pendiente | 1.1 |
| Confirmados por WhatsApp / sin confirmar / fallidos | pendiente | 1.1 `estadoFinal` |
| Motivos de fallo | pendiente | 1.1 `motivosDeFallo` |
| Cola: primer encolado → última confirmación | pendiente | 1.1 `cola` y 1.2 |
| Contestaron (72 h) y tasa | pendiente | 1.1 `respuestas` |
| Minutos hasta responder: mediana · p90 · máximo | pendiente | 1.1 |
| Agente: llamadas y costo en MXN | pendiente | 1.1 `agente` |

## 3. Lo que NO se puede reconstruir de la bitácora

- **Quién pagó.** Ni el orquestador ni monday registran el pago aquí; el
  "~$1M de cartera" sale del CRM de We Build, no de estos datos.
- **Lectura del mensaje** (doble palomita azul): WhatsApp la acusa, pero
  el orquestador solo guarda la confirmación de entrega; no se distingue
  leído de entregado.
- **Respuestas fuera de la ventana** de 72 h o por otro canal (llamada,
  correo).
- **La hora exacta de envío** si el journal ya rotó (§1.2).
