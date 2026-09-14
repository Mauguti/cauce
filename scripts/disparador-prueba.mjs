#!/usr/bin/env node
/**
 * Siembra (o quita) UN disparador de prueba en un tenant para probar el
 * imbot del canal abierto sin adelantar la sección de Bots de la
 * plataforma. Escribe en `tenants/<t>/config/disparadores.lista`, que es
 * exactamente lo que lee el motor de entrada; conserva los demás
 * disparadores del tenant si los hubiera.
 *
 * El disparador es por palabra clave: solo responde cuando el contacto
 * escribe exactamente "prueba bot". No interfiere con nada más.
 *
 * Uso (en la EC2 o donde haya credenciales de Firestore, como migrar-planes):
 *   CAUCE_FIRESTORE_DB=factory node scripts/disparador-prueba.mjs --tenant 9e718a68            # muestra
 *   CAUCE_FIRESTORE_DB=factory node scripts/disparador-prueba.mjs --tenant 9e718a68 --poner    # siembra
 *   CAUCE_FIRESTORE_DB=factory node scripts/disparador-prueba.mjs --tenant 9e718a68 --quitar   # retira
 *
 * Para que el bot dispare de verdad hacen falta, además:
 *   - plan con capacidad `bots` (Estándar o Pro), o sale `bots.pausados`;
 *   - que la conversación NO esté en ventana humana: si un operador
 *     respondió desde Bitrix a ese contacto en los últimos 30 min, sale
 *     `bots.pausados_por_operador` y el bot calla. Usar otro contacto o esperar.
 */
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const tenant = arg("--tenant");
const poner = process.argv.includes("--poner");
const quitar = process.argv.includes("--quitar");
if (!tenant || (poner && quitar)) {
  console.error("uso: --tenant <id> [--poner | --quitar]");
  process.exit(2);
}

const ID = "prueba-imbot";
const DISPARADOR = {
  id: ID,
  prioridad: 1,
  tipo: "palabra_clave",
  patron: "prueba bot",
  coincidencia: "igual",
  activo: true,
  respuesta: "🤖 Respuesta automática de prueba de Digsol Factory. Si ves esto en el chat de Bitrix y UNA sola vez en WhatsApp, la prueba del imbot pasó.",
};

admin.initializeApp();
const dbId = process.env.CAUCE_FIRESTORE_DB?.trim() || "(default)";
const db = getFirestore(admin.app(), dbId);
const ref = db.doc(`tenants/${tenant}/config/disparadores`);

const snap = await ref.get();
const lista = snap.exists ? (snap.data().lista ?? []) : [];
console.log(`[${dbId}] tenant ${tenant} · disparadores actuales: ${lista.length}`);
for (const d of lista) console.log(`  ${d.id}  ${d.tipo}  activo=${d.activo}  ${d.patron ? `patron="${d.patron}"` : ""}`);

if (poner) {
  const otros = lista.filter((d) => d.id !== ID);
  await ref.set({ lista: [DISPARADOR, ...otros] });
  console.log(`sembrado "${ID}": el contacto escribe "prueba bot" y el bot responde. Total: ${otros.length + 1}`);
} else if (quitar) {
  const otros = lista.filter((d) => d.id !== ID);
  if (otros.length === lista.length) console.log(`"${ID}" no estaba; nada que quitar`);
  else { await ref.set({ lista: otros }); console.log(`retirado "${ID}". Total: ${otros.length}`); }
} else {
  console.log("(sin --poner ni --quitar: solo se muestra)");
}
