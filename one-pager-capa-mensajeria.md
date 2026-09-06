# [Sin nombre] — Capa de mensajería para CRMs

**One-pager v0.1 · Septiembre 2026 · DigSol**

---

## El problema

Las empresas gestionan a sus clientes en un CRM (monday, Bitrix24, Pipedrive) pero se comunican con ellos por WhatsApp, desde el celular de un ejecutivo. Son dos mundos separados: el CRM tiene el dato y el celular tiene la conversación.

Eso produce tres costos diarios: recordatorios de cobranza que se mandan a mano uno por uno, respuestas de clientes que nunca llegan al expediente, y cero trazabilidad cuando el ejecutivo se va y se lleva el historial en su teléfono.

Las soluciones existentes obligan a usar un número nuevo de la API oficial de Meta. El cliente no quiere eso: quiere seguir usando el número que sus clientes ya tienen guardado.

---

## La solución

Una capa de mensajería que se conecta al CRM que la empresa ya usa y le permite mandar y recibir mensajes **desde su propio número**, con la conversación escrita de vuelta al registro que la originó.

**Cómo funciona:**

1. El cliente conecta su número escaneando un QR. Sesión aislada, sin configuración técnica de su lado.
2. Arma la condición en su CRM con la UI que ya conoce ("si la fecha de pago es hoy y el estatus es pendiente").
3. El CRM dispara un webhook. Nosotros armamos el mensaje con las variables del registro y lo mandamos.
4. La respuesta del cliente regresa como update en el mismo item o deal.

---

## Diferenciador

Dos cosas, y ninguna es el envío de mensajes:

**Su propio número.** No hay migración, no hay número nuevo, no se pierde el historial. Es la razón principal de compra.

**El retorno al CRM.** Un enviador de mensajes lo vende cualquiera. La conversación viviendo dentro del registro es lo que hace que el CRM deje de estar incompleto. Ahí está el valor defendible.

---

## Alcance por fases

**Fase 1 — Motor + monday**
Orquestador multi-tenant, sesión aislada por cliente, conexión por QR, cola con control de ritmo, envío disparado por webhook, respuesta escrita de vuelta al item. Cliente cero: We Build (cobranza).

**Fase 2 — Vista conversacional + Bitrix24 y Pipedrive**
Sección para leer el hilo completo dentro de la app. Conectores adicionales sobre el mismo motor.

**Fase 3 — Bots**
Árbol de decisión configurable (marca 1, marca 2) como tier plano. Bot con IA después, con límites duros y costo variable medido por conversación.

---

## Por qué cobranza primero

Cobranza y prospección son la misma tecnología con perfiles de riesgo opuestos. En cobranza el destinatario ya es cliente, ya tiene el número agregado y espera el mensaje: la tasa de reporte es casi cero. En prospección en frío la gente bloquea y reporta, y esa señal es la que mata números.

Arrancar por cobranza también significa arrancar con un caso probado: CobrAI ya corre en We Build.

---

## Modelo de negocio

| Concepto | Estructura |
|---|---|
| Setup por cliente | Único — cubre alta, conexión y configuración inicial |
| Suscripción mensual | Por número conectado |
| Números adicionales | Incremental sobre la mensualidad |
| Conector extra | Por CRM adicional en la misma cuenta |
| Bots (fase 3) | Tier superior; el de IA con costo variable repercutido |

Márgenes por definir contra el costo real de infraestructura (ver riesgos).

---

## Distribución

Venta directa desde la cartera existente de DigSol. No se publica en marketplaces públicos.

La política de integraciones redundantes de monday no es el obstáculo — cobranza especializada califica como vertical. El obstáculo es el requisito de API oficial, incompatible con "tu propio número". Como producto standalone eso deja de importar: cada cliente lo instala como app privada o webhook nativo en su cuenta, sin review de por medio.

Consecuencia asumida: no hay descubrimiento orgánico. El canal es la relación comercial existente.

---

## Riesgos

**Dependencia de librería no oficial.** El transporte corre sobre una implementación reverseada de WhatsApp Web. Cuando Meta cambia el protocolo, se rompe para toda la flota hasta que haya parche. *Mitigación:* capa de transporte intercambiable desde el primer commit; API oficial como implementación alterna disponible.

**Baneo de números del cliente.** Control de ritmo y cola obligatorios. Cobranza primero, prospección solo con base instalada y datos propios.

**Costo de infraestructura.** Cada sesión consume varios cientos de MB de RAM más volumen persistente. Aislar por cliente da seguridad pero el costo crece lineal con la base. Hay que dimensionarlo antes de fijar precio, o el producto crece y empobrece.

**Carga operativa.** El trabajo real no es levantar sesiones, es mantenerlas: health checks, reconexión, alerta de caída y re-escaneo de QR. Eso es soporte, no código.

**Deriva hacia consultoría.** Riesgo principal del modelo. Si dar de alta a un cliente requiere abrir n8n o tocar código, no es producto.

---

## Qué NO es

- No es un inbox nuevo — el cliente ya tiene el suyo.
- No es un motor de reglas — las condiciones se arman en el CRM.
- No es un flujo de n8n por cliente — la lógica es común, la configuración es por tenant.
- No se nombra ni se presenta con marcas de terceros.

---

## Prueba de que va bien

- Un cliente conecta su número sin intervención técnica.
- Un mensaje sale por condición del CRM y la respuesta aparece en el registro.
- El segundo cliente se da de alta sin escribir código.
- Un conector nuevo toma semanas, no meses.
