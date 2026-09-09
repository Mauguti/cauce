#!/usr/bin/env node
/**
 * Migración de planes legado → modelo de capacidades. Idempotente.
 *
 *   base   → estandar
 *   extras → estandar + limitesOverride { lineas: 99, conectores: 99 }
 *   limiteLineas / limiteConectores (campos deprecados) → limitesOverride
 *   planes desconocidos → NO se tocan; se registran y se sigue.
 *
 * Por defecto solo reporta. Con --aplicar escribe.
 * Corre donde haya credenciales de Admin SDK del proyecto. La base la
 * fija CAUCE_FIRESTORE_DB (vacía = (default), que es la de Cauce):
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json node scripts/migrar-planes.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/factory-firestore.json CAUCE_FIRESTORE_DB=factory node scripts/migrar-planes.mjs --aplicar
 *
 * Orden seguro: desplegar primero el orquestador nuevo (tolera los ids
 * legado al leer) y correr esto después. Nunca al revés: el orquestador
 * viejo no conoce "estandar".
 */
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const aplicar = process.argv.includes("--aplicar");
const CONOCIDOS = new Set(["prueba", "basico", "estandar", "pro"]);
const LEGADO = new Set(["base", "extras"]);

admin.initializeApp();
const dbId = process.env.CAUCE_FIRESTORE_DB?.trim() || "(default)";
const db = getFirestore(admin.app(), dbId);

const snap = await db.collection("tenants").get();
let migrados = 0, sinCambios = 0, desconocidos = 0;
console.log(`[${dbId}] tenants: ${snap.size} · modo: ${aplicar ? "APLICAR" : "solo reporte"}`);

for (const d of snap.docs) {
  const t = d.data();
  const plan = String(t.plan ?? "");
  const cambios = {};

  if (LEGADO.has(plan)) {
    cambios.plan = "estandar";
    if (plan === "extras") {
      cambios.limitesOverride = { ...(t.limitesOverride ?? {}), lineas: t.limitesOverride?.lineas ?? t.limiteLineas ?? 99, conectores: t.limitesOverride?.conectores ?? t.limiteConectores ?? 99 };
    }
  } else if (!CONOCIDOS.has(plan)) {
    desconocidos += 1;
    console.log(`  ${d.id}  plan="${plan}"  → DESCONOCIDO, no se toca`);
    continue;
  }

  // Campos deprecados → override (sin pisar un override ya existente).
  const override = { ...(t.limitesOverride ?? {}), ...(cambios.limitesOverride ?? {}) };
  if (typeof t.limiteLineas === "number" && override.lineas === undefined) override.lineas = t.limiteLineas;
  if (typeof t.limiteConectores === "number" && override.conectores === undefined) override.conectores = t.limiteConectores;
  if (Object.keys(override).length > 0 && JSON.stringify(override) !== JSON.stringify(t.limitesOverride ?? {})) cambios.limitesOverride = override;
  if (t.limiteLineas !== undefined) cambios.limiteLineas = FieldValue.delete();
  if (t.limiteConectores !== undefined) cambios.limiteConectores = FieldValue.delete();

  if (Object.keys(cambios).length === 0) { sinCambios += 1; continue; }
  const resumen = Object.entries(cambios).map(([k, v]) => `${k}=${v instanceof FieldValue ? "(borrar)" : JSON.stringify(v)}`).join(" ");
  console.log(`  ${d.id}  plan="${plan}"  → ${resumen}`);
  if (aplicar) await d.ref.update(cambios);
  migrados += 1;
}
console.log(`\nmigrados: ${migrados}${aplicar ? "" : " (sin escribir)"} · sin cambios: ${sinCambios} · desconocidos: ${desconocidos}`);
