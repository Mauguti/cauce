#!/usr/bin/env node
/**
 * Siembra (o quita) UN disparador de prueba en un tenant para probar el
 * imbot del canal abierto sin adelantar la sección de Bots de la
 * plataforma. Escribe en `tenants/<t>/config/disparadores.lista`, que es
 * exactamente lo que lee el motor de entrada; conserva los demás
 * disparadores del tenant si los hubiera.
 *
 * El disparador es por palabra clave: responde cuando el texto del
 * contacto CONTIENE "prueba bot" (sin distinguir mayúsculas ni acentos;
 * signos y texto alrededor no estorban). No interfiere con nada más.
 *
 * El motor NO cachea los disparadores: los lee de Firestore en cada
 * entrante. Sembrar después de reiniciar es válido. Lo que sí importa es
 * la base: sin CAUCE_FIRESTORE_DB=factory se escribe en (default), que el
 * orquestador de México no lee.
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
  coincidencia: "contiene",
  activo: true,
  respuesta: "🤖 Respuesta automática de prueba de Digsol Factory. Si ves esto en el chat de Bitrix y UNA sola vez en WhatsApp, la prueba del imbot pasó.",
};

admin.initializeApp();
const dbId = process.env.CAUCE_FIRESTORE_DB?.trim() || "(default)";
const db = getFirestore(admin.app(), dbId);
const ref = db.doc(`tenants/${tenant}/config/disparadores`);

if (dbId === "(default)") {
  console.error("AVISO: CAUCE_FIRESTORE_DB no está definida; se escribiría en la base (default). México lee la base 'factory'. Exporta CAUCE_FIRESTORE_DB=factory.");
  if (poner || quitar) process.exit(2);
}
const snap = await ref.get();
const lista = snap.exists ? (snap.data().lista ?? []) : [];
console.log(`[${dbId}] tenant ${tenant} · disparadores actuales: ${lista.length}`);
for (const d of lista) console.log(`  ${d.id}  ${d.tipo}  activo=${d.activo}  ${d.patron ? `patron="${d.patron}"` : ""}`);

if (poner) {
  const otros = lista.filter((d) => d.id !== ID);
  await ref.set({ lista: [DISPARADOR, ...otros] });
  console.log(`sembrado "${ID}" en tenants/${tenant}/config/disparadores de la base ${dbId}.`);
  console.log(`Coincide cuando el texto CONTIENE "prueba bot" (minúsculas/acentos indiferentes). Total de disparadores: ${otros.length + 1}`);
  console.log("Recuerda: plan con bots (Estándar/Pro) y contacto SIN respuesta de operador en los últimos 30 min. La bitácora dirá 'entrada.respuesta' con el motivo.");
} else if (quitar) {
  const otros = lista.filter((d) => d.id !== ID);
  if (otros.length === lista.length) console.log(`"${ID}" no estaba; nada que quitar`);
  else { await ref.set({ lista: otros }); console.log(`retirado "${ID}". Total: ${otros.length}`); }
} else {
  console.log("(sin --poner ni --quitar: solo se muestra)");
}
