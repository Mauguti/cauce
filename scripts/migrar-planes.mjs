#!/usr/bin/env node
/**
 * Migración de planes legado → modelo de capacidades. Idempotente y REVERSIBLE.
 *
 *   base   → estandar
 *   extras → estandar + limitesOverride { lineas: 99, conectores: 99 }
 *   limiteLineas / limiteConectores (campos deprecados) → limitesOverride
 *   planes desconocidos → NO se tocan; se registran y se sigue.
 *
 * Modos:
 *   (sin flags)  solo reporte, no escribe
 *   --aplicar    escribe, y REGISTRA cada tenant tocado con su estado previo en
 *                migraciones/planes-capacidades (Firestore) y en un JSON local
 *   --revertir   devuelve a su estado previo exacto los tenants registrados
 *                (base/extras, campos deprecados y override previos). Idempotente:
 *                un tenant ya revertido no se toca dos veces.
 *
 * Rollback completo = PRIMERO --revertir (el orquestador nuevo tolera los ids
 * legado), DESPUÉS volver al código anterior. Nunca al revés: el orquestador
 * viejo no conoce "estandar".
 *
 * Corre donde haya credenciales de Admin SDK del proyecto. La base la fija
 * CAUCE_FIRESTORE_DB (vacía = (default), la de Cauce):
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json node scripts/migrar-planes.mjs
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json node scripts/migrar-planes.mjs --aplicar
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json node scripts/migrar-planes.mjs --revertir
 */
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { writeFileSync } from "node:fs";

const aplicar = process.argv.includes("--aplicar");
const revertir = process.argv.includes("--revertir");
if (aplicar && revertir) { console.error("elige --aplicar o --revertir, no ambos"); process.exit(2); }

const CONOCIDOS = new Set(["prueba", "basico", "estandar", "pro"]);
const LEGADO = new Set(["base", "extras"]);
const REGISTRO = "migraciones/planes-capacidades";

admin.initializeApp();
const dbId = process.env.CAUCE_FIRESTORE_DB?.trim() || "(default)";
const db = getFirestore(admin.app(), dbId);
const registroRef = db.doc(REGISTRO);
const ahora = new Date().toISOString();

/** Snapshot mínimo para poder deshacer exactamente. */
function previo(t) {
  return {
    plan: String(t.plan ?? ""),
    limiteLineas: typeof t.limiteLineas === "number" ? t.limiteLineas : null,
    limiteConectores: typeof t.limiteConectores === "number" ? t.limiteConectores : null,
    limitesOverride: t.limitesOverride ?? null,
  };
}

if (revertir) {
  const reg = (await registroRef.get()).data() ?? {};
  const tocados = reg.tocados ?? {};
  const ids = Object.keys(tocados);
  console.log(`[${dbId}] --revertir · tenants registrados por la migración: ${ids.length}`);
  let revertidos = 0, yaRevertidos = 0, ausentes = 0;
  for (const id of ids) {
    const r = tocados[id];
    if (r.revertidoEn) { yaRevertidos += 1; continue; }
    const ref = db.doc(`tenants/${id}`);
    const snap = await ref.get();
    if (!snap.exists) { ausentes += 1; console.log(`  ${id}  ya no existe; se omite`); continue; }
    const p = r.previo;
    const cambios = {
      plan: p.plan,
      limiteLineas: p.limiteLineas ?? FieldValue.delete(),
      limiteConectores: p.limiteConectores ?? FieldValue.delete(),
      limitesOverride: p.limitesOverride ?? FieldValue.delete(),
    };
    console.log(`  ${id}  ${snap.data().plan} → ${p.plan}${p.limitesOverride ? "" : " (override retirado)"}`);
    await ref.update(cambios);
    await registroRef.set({ tocados: { [id]: { ...r, revertidoEn: ahora } } }, { merge: true });
    revertidos += 1;
  }
  console.log(`\nrevertidos: ${revertidos} · ya revertidos antes: ${yaRevertidos} · ausentes: ${ausentes}`);
  process.exit(0);
}

const snap = await db.collection("tenants").get();
let migrados = 0, sinCambios = 0, desconocidos = 0;
const tocadosAhora = {};
console.log(`[${dbId}] tenants: ${snap.size} · modo: ${aplicar ? "APLICAR" : "solo reporte"}`);

for (const d of snap.docs) {
  const t = d.data();
  const plan = String(t.plan ?? "");
  const cambios = {};

  if (LEGADO.has(plan)) {
    cambios.plan = "estandar";
    if (plan === "extras") {
      cambios.limitesOverride = {
        ...(t.limitesOverride ?? {}),
        lineas: t.limitesOverride?.lineas ?? t.limiteLineas ?? 99,
        conectores: t.limitesOverride?.conectores ?? t.limiteConectores ?? 99,
      };
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
  console.log(`  ${d.id}  (${t.nombre ?? "sin nombre"})  plan="${plan}"  → ${resumen}`);
  if (aplicar) {
    // Primero el registro, luego el cambio: si algo falla a medias, el
    // registro ya dice qué había y --revertir puede devolverlo.
    tocadosAhora[d.id] = { previo: previo(t), migradoEn: ahora };
    await registroRef.set({ tocados: { [d.id]: tocadosAhora[d.id] }, base: dbId }, { merge: true });
    await d.ref.update(cambios);
  }
  migrados += 1;
}
if (aplicar && Object.keys(tocadosAhora).length > 0) {
  const archivo = `migracion-planes-${dbId.replace(/[^a-z0-9]/gi, "_")}-${ahora.replace(/[:.]/g, "-")}.json`;
  writeFileSync(archivo, JSON.stringify({ base: dbId, en: ahora, tocados: tocadosAhora }, null, 2));
  console.log(`\nregistro de lo tocado: Firestore ${REGISTRO} y archivo ${archivo} (guárdalo fuera del servidor)`);
}
console.log(`\nmigrados: ${migrados}${aplicar ? "" : " (sin escribir)"} · sin cambios: ${sinCambios} · desconocidos: ${desconocidos}`);
