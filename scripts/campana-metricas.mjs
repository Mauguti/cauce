#!/usr/bin/env node
/**
 * Métricas AGREGADAS de una campaña de salientes (p. ej. cobranza de We
 * Build por el conector de monday), leídas de Firestore. SOLO LECTURA.
 *
 * Regla dura: la salida no contiene teléfonos ni nombres. Los contactos se
 * cuentan por un hash interno que nunca se imprime. Lo que sale es apto
 * para material comercial.
 *
 * Correr en la EC2 (donde está la credencial), con la copia dentro del árbol
 * del orquestador para que resuelva @google-cloud/firestore:
 *
 *   sudo bash -c 'set -a; . /etc/factory.env; set +a; cd /opt/factory/apps/orchestrator && \
 *     node _campana-metricas-tmp.mjs --tenant <id> --desde 2026-10-13T00:00:00-06:00 --hasta 2026-10-14T00:00:00-06:00 [--origen crm] [--json]'
 *
 * Qué mide y de dónde:
 * - Salientes de campaña: `tenants/{t}/messages` con direccion=out, origen
 *   (default `crm` = disparados por el CRM) y timestamp en la ventana.
 * - Ventana real, líneas, contactos distintos, estado final (enviado /
 *   confirmado por WhatsApp / fallido / sin confirmar / aún encolado) y
 *   motivo de fallo (errorCodigo).
 * - Respuestas: primer entrante de cada contacto POSTERIOR a su primer
 *   saliente de campaña, hasta `--respuestas-horas` (default 72) después:
 *   cuántos contestaron y en cuánto tiempo (mediana, p90, máximo).
 * - Cola: del primer saliente encolado al último confirmado (o enviado).
 *   La hora exacta de envío vive en el journal (`envio.enviado`); aquí es
 *   la confirmación de WhatsApp (`confirmadoEn`), que llega segundos después.
 * - Agente: llamadas de `tenants/{t}/consumo/{mes}/llamadas` en la ventana,
 *   en USD y en pesos con CAUCE_USD_MXN × CAUCE_USD_MXN_COLCHON del entorno.
 */
import { createHash } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const opcion = (n, def = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const tenant = opcion("tenant");
const desde = opcion("desde");
const hasta = opcion("hasta");
const origen = opcion("origen", "crm");
const respuestasHoras = Number(opcion("respuestas-horas", "72"));
const json = args.includes("--json");
if (!tenant || !desde || !hasta || Number.isNaN(Date.parse(desde)) || Number.isNaN(Date.parse(hasta))) {
  console.error("Uso: --tenant <id> --desde <ISO> --hasta <ISO> [--origen crm|manual|todos] [--respuestas-horas 72] [--json]");
  process.exit(2);
}
const desdeIso = new Date(desde).toISOString();
const hastaIso = new Date(hasta).toISOString();
const databaseId = process.env.CAUCE_FIRESTORE_DB?.trim() || undefined;
const db = new Firestore(databaseId ? { databaseId } : {});
const usdMxn = Number(process.env.CAUCE_USD_MXN) > 0 ? Number(process.env.CAUCE_USD_MXN) : 17.15;
const colchon = Number(process.env.CAUCE_USD_MXN_COLCHON) > 0 ? Number(process.env.CAUCE_USD_MXN_COLCHON) : 1.1;
const sal = Buffer.from(createHash("sha256").update(`campana:${tenant}:${desdeIso}`).digest("hex").slice(0, 16));
const anon = (tel) => createHash("sha256").update(sal).update(String(tel ?? "").replace(/\D/g, "")).digest("hex").slice(0, 12);

// Todos los mensajes del tenant (los salientes de la ventana y los entrantes hasta la ventana de respuesta).
const topeRespuestas = new Date(Date.parse(hastaIso) + respuestasHoras * 3_600_000).toISOString();
const snap = await db.collection(`tenants/${tenant}/messages`).where("timestamp", ">=", desdeIso).where("timestamp", "<=", topeRespuestas).get();
const mensajes = snap.docs.map((d) => d.data());

const salientes = mensajes.filter((m) => m.direccion === "out" && m.timestamp >= desdeIso && m.timestamp <= hastaIso && (origen === "todos" || (m.origen ?? "manual") === origen));
if (salientes.length === 0) {
  console.log(`Sin salientes con origen=${origen} entre ${desdeIso} y ${hastaIso} en el tenant ${tenant}. Prueba --origen todos.`);
  process.exit(0);
}
const estadoFinal = (m) => (m.estado === "fallido" ? "fallido" : m.estado === "no_confirmado" ? "sin_confirmar" : m.estado === "enviado" ? (m.confirmadoEn ? "confirmado" : "enviado") : m.estado);
const conteoPor = (lista, f) => lista.reduce((acc, x) => { const k = f(x) ?? "(ninguno)"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const tiempos = salientes.map((m) => Date.parse(m.timestamp)).sort((a, b) => a - b);
const confirmaciones = salientes.map((m) => m.confirmadoEn && Date.parse(m.confirmadoEn)).filter(Boolean).sort((a, b) => a - b);
const porLinea = conteoPor(salientes, (m) => m.instanceId);
const contactos = new Map(); // hash → primer saliente
for (const m of salientes) { const h = anon(m.telefono); if (!contactos.has(h) || Date.parse(m.timestamp) < contactos.get(h)) contactos.set(h, Date.parse(m.timestamp)); }
const estados = conteoPor(salientes, estadoFinal);
const fallos = conteoPor(salientes.filter((m) => estadoFinal(m) === "fallido" || estadoFinal(m) === "sin_confirmar"), (m) => m.errorCodigo ?? (estadoFinal(m) === "sin_confirmar" ? "sin_confirmacion_de_whatsapp" : "sin_codigo"));

// Respuestas: primer entrante de cada contacto después de su primer saliente de campaña.
const entrantes = mensajes.filter((m) => m.direccion === "in");
const lagMin = [];
let contestaron = 0;
for (const [h, primerSaliente] of contactos) {
  const resp = entrantes.filter((m) => anon(m.telefono) === h && Date.parse(m.timestamp) > primerSaliente && Date.parse(m.timestamp) <= primerSaliente + respuestasHoras * 3_600_000).map((m) => Date.parse(m.timestamp)).sort((a, b) => a - b)[0];
  if (resp !== undefined) { contestaron += 1; lagMin.push((resp - primerSaliente) / 60_000); }
}
lagMin.sort((a, b) => a - b);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null);
const minutos = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 60_000));

// Agente: consumo en la ventana (mes de la ventana y el siguiente por si cruza).
let llamadas = [];
for (const mes of new Set([desdeIso.slice(0, 7), topeRespuestas.slice(0, 7)])) {
  const c = await db.collection(`tenants/${tenant}/consumo/${mes}/llamadas`).get();
  llamadas.push(...c.docs.map((d) => d.data()).filter((l) => l.en >= desdeIso && l.en <= topeRespuestas));
}
const costoUsd = llamadas.reduce((s, l) => s + (l.costoUsd ?? 0), 0);

const salida = {
  tenant, origen, ventana: { desde: desdeIso, hasta: hastaIso },
  salientes: {
    total: salientes.length,
    primero: new Date(tiempos[0]).toISOString(),
    ultimo: new Date(tiempos[tiempos.length - 1]).toISOString(),
    duracionEncoladoMin: minutos(tiempos[tiempos.length - 1] - tiempos[0]),
    lineas: Object.keys(porLinea).length,
    porLinea,
    contactosDistintos: contactos.size,
    estadoFinal: estados,
    motivosDeFallo: fallos,
  },
  cola: {
    primerEncolado: new Date(tiempos[0]).toISOString(),
    ultimaConfirmacion: confirmaciones.length ? new Date(confirmaciones[confirmaciones.length - 1]).toISOString() : null,
    vaciadoMin: confirmaciones.length ? minutos(confirmaciones[confirmaciones.length - 1] - tiempos[0]) : null,
    nota: "del primer saliente encolado a la última confirmación de WhatsApp; la hora exacta de envío está en el journal (envio.enviado)",
  },
  respuestas: {
    ventanaHoras: respuestasHoras,
    contactosQueContestaron: contestaron,
    tasa: contactos.size ? Math.round((contestaron / contactos.size) * 1000) / 10 : 0,
    minutosHastaResponder: { mediana: pct(lagMin, 0.5) && Math.round(pct(lagMin, 0.5)), p90: pct(lagMin, 0.9) && Math.round(pct(lagMin, 0.9)), maximo: lagMin.length ? Math.round(lagMin[lagMin.length - 1]) : null },
    entrantesTotalesEnVentana: entrantes.filter((m) => contactos.has(anon(m.telefono))).length,
  },
  agente: { llamadas: llamadas.length, costoUsd: Math.round(costoUsd * 1e6) / 1e6, costoMxn: Math.round(costoUsd * usdMxn * colchon * 100) / 100, tipoCambio: { usdMxn, colchon } },
};
if (json) { console.log(JSON.stringify(salida, null, 2)); process.exit(0); }
console.log(`Campaña · tenant ${tenant} · origen=${origen} · ${desdeIso} → ${hastaIso}`);
console.log(`Salientes: ${salida.salientes.total} · líneas: ${salida.salientes.lineas} · contactos distintos: ${salida.salientes.contactosDistintos}`);
console.log(`  primero ${salida.salientes.primero} · último ${salida.salientes.ultimo} · encolado en ${salida.salientes.duracionEncoladoMin} min`);
console.log(`  por línea: ${JSON.stringify(porLinea)}`);
console.log(`  estado final: ${JSON.stringify(estados)}`);
console.log(`  motivos de fallo: ${JSON.stringify(fallos)}`);
console.log(`Cola: primer encolado ${salida.cola.primerEncolado} · última confirmación ${salida.cola.ultimaConfirmacion} · vaciado en ${salida.cola.vaciadoMin} min`);
console.log(`Respuestas (${respuestasHoras} h): ${contestaron} de ${contactos.size} contactos (${salida.respuestas.tasa} %) · minutos hasta responder: mediana ${salida.respuestas.minutosHastaResponder.mediana} · p90 ${salida.respuestas.minutosHastaResponder.p90} · máx ${salida.respuestas.minutosHastaResponder.maximo}`);
console.log(`Agente: ${llamadas.length} llamadas · ${salida.agente.costoUsd} USD · ${salida.agente.costoMxn} MXN (${usdMxn} × ${colchon})`);
console.log(`\nSin teléfonos ni nombres: los contactos se contaron por hash interno.`);
