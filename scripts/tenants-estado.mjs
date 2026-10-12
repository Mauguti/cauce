#!/usr/bin/env node
/**
 * Reporte de SOLO LECTURA de los tenants de la base `factory`: id, nombre,
 * plan, estado, pagadoHasta, cicloCorteEn, agente (rol) y líneas. Sirve
 * para la comprobación previa al despliegue: ningún tenant debe traer
 * estado "suspendido" por accidente (perdería escritura de golpe).
 *
 * Correr en la EC2 de México (donde está la credencial):
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/factory-firestore.json \
 *   CAUCE_FIRESTORE_DB=factory NODE_PATH=/opt/factory/node_modules \
 *   node scripts/tenants-estado.mjs
 *
 * No escribe nada. Sale con código 2 si hay algún tenant suspendido.
 */
import { Firestore } from "@google-cloud/firestore";

const databaseId = process.env.CAUCE_FIRESTORE_DB?.trim() || undefined;
const db = new Firestore(databaseId ? { databaseId } : {});

const snap = await db.collection("tenants").get();
let suspendidos = 0;
const filas = [];
for (const d of snap.docs) {
  const t = d.data();
  const lineas = await db.collection(`tenants/${d.id}/instances`).get();
  if (t.estado === "suspendido") suspendidos += 1;
  filas.push({
    id: d.id,
    nombre: t.nombre ?? "",
    plan: t.plan ?? "",
    estado: t.estado ?? "(sin estado)",
    pagadoHasta: t.pagadoHasta ?? null,
    cicloCorteEn: t.cicloCorteEn ?? null,
    pruebaExpiraEn: t.pruebaExpiraEn ?? null,
    agente: t.agente ? `${t.agente.nombre}/${t.agente.rol ?? "ventas"}${t.agente.activo ? "" : " (apagado)"}` : null,
    creditosMxn: t.creditosMxn ?? null,
    lineas: lineas.size,
  });
}
console.log(`base: ${databaseId ?? "(default)"} · tenants: ${filas.length} · suspendidos: ${suspendidos}`);
console.table(filas);
if (suspendidos > 0) {
  console.error(`\n⛔ ${suspendidos} tenant(s) con estado "suspendido". Al desplegar quedarían en solo lectura. Revisar antes.`);
  process.exit(2);
}
