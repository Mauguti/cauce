#!/usr/bin/env node
/**
 * Cuenta, SOLO LECTURA, cuántas conversaciones están partidas en dos por
 * la forma del teléfono: los salientes del CRM llegan como +52 + 10 dígitos
 * y los entrantes de WhatsApp como +521 + 10 (el JID mexicano). Misma
 * persona, dos documentos `conversaciones/{telefono}` bajo la misma línea.
 *
 * Forma canónica propuesta: la del JID de WhatsApp (521 + 10 dígitos), que
 * es la que ya usan los chats del Contact Center de Bitrix (chat id =
 * instancia:teléfono del entrante). Así la migración no toca Bitrix.
 *
 * Imprime conteos y categorías; NUNCA teléfonos ni nombres. No escribe.
 *
 *   sudo bash -c 'set -a; . /etc/factory.env; set +a; cd /opt/factory/apps/orchestrator && \
 *     node _conversaciones-partidas-tmp.mjs [--tenant <id>]'
 */
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const i = args.indexOf("--tenant");
const soloTenant = i >= 0 ? args[i + 1] : null;
const databaseId = process.env.CAUCE_FIRESTORE_DB?.trim() || undefined;
const db = new Firestore(databaseId ? { databaseId } : {});

/** 52 + 10 dígitos → 521 + 10 (forma del JID). Lo demás, igual. */
function canonico(tel) {
  const d = String(tel ?? "").replace(/\D/g, "");
  return d.length === 12 && d.startsWith("52") ? `521${d.slice(2)}` : d;
}

const tenants = soloTenant ? [soloTenant] : (await db.collection("tenants").get()).docs.map((d) => d.id);
const totales = { tenants: 0, conversaciones: 0, canonicas: 0, partidas: 0 };
for (const t of tenants) {
  const instancias = (await db.collection(`tenants/${t}/instances`).get()).docs.map((d) => d.id);
  let convs = [];
  for (const inst of instancias) {
    const snap = await db.collection(`tenants/${t}/instances/${inst}/conversaciones`).get();
    convs.push(...snap.docs.map((d) => ({ inst, id: d.id, ...d.data() })));
  }
  if (convs.length === 0) continue;
  const grupos = new Map();
  for (const c of convs) {
    const k = `${c.inst}/${canonico(c.telefono ?? c.id)}`;
    grupos.set(k, [...(grupos.get(k) ?? []), c]);
  }
  const partidas = [...grupos.values()].filter((g) => g.length > 1);
  const cat = { soloUnaConEntrantes: 0, ambasConEntrantes: 0, mondayDistinto: 0, mondayIgualOUnaSola: 0, bitrixEntidadDistinta: 0, ambasConChatBitrix: 0, conTraspasoOCitaPendiente: 0, conVentanaHumanaViva: 0, masDeDos: 0 };
  const ahora = new Date().toISOString();
  for (const g of partidas) {
    if (g.length > 2) cat.masDeDos += 1;
    const conEntrantes = g.filter((c) => c.primerContactoEn);
    if (conEntrantes.length === 1) cat.soloUnaConEntrantes += 1; else if (conEntrantes.length > 1) cat.ambasConEntrantes += 1;
    const monday = [...new Set(g.map((c) => c.mondayItemId).filter(Boolean))];
    if (monday.length > 1) cat.mondayDistinto += 1; else if (monday.length === 1) cat.mondayIgualOUnaSola += 1;
    const bx = [...new Set(g.map((c) => (c.bitrixEntidad ? `${c.bitrixEntidad.tipo}:${c.bitrixEntidad.id}` : null)).filter(Boolean))];
    if (bx.length > 1) cat.bitrixEntidadDistinta += 1;
    if (g.filter((c) => c.bitrixOpenLine?.chatId).length > 1) cat.ambasConChatBitrix += 1;
    if (g.some((c) => c.traspaso && !c.traspaso.atendidoEn) || g.some((c) => c.citaPendiente)) cat.conTraspasoOCitaPendiente += 1;
    if (g.some((c) => c.humanaHasta && c.humanaHasta > ahora)) cat.conVentanaHumanaViva += 1;
  }
  // Mensajes: cuántos salientes y entrantes caen en cada variante (solo conteos).
  const msgs = (await db.collection(`tenants/${t}/messages`).select("direccion", "telefono").get()).docs.map((d) => d.data());
  const porForma = { salientes52: 0, salientes521: 0, entrantes52: 0, entrantes521: 0, otros: 0 };
  for (const m of msgs) {
    const d = String(m.telefono ?? "").replace(/\D/g, "");
    const forma = d.length === 12 && d.startsWith("52") ? "52" : d.length === 13 && d.startsWith("521") ? "521" : null;
    if (!forma) { porForma.otros += 1; continue; }
    porForma[`${m.direccion === "in" ? "entrantes" : "salientes"}${forma}`] += 1;
  }
  console.log(`\n== tenant ${t}: ${convs.length} conversaciones → ${grupos.size} canónicas · PARTIDAS: ${partidas.length} (${partidas.reduce((s, g) => s + g.length, 0)} docs)`);
  console.log(`   categorías de las partidas: ${JSON.stringify(cat)}`);
  console.log(`   mensajes por forma del teléfono: ${JSON.stringify(porForma)}`);
  totales.tenants += 1; totales.conversaciones += convs.length; totales.canonicas += grupos.size; totales.partidas += partidas.length;
}
console.log(`\nTOTAL: ${totales.tenants} tenants · ${totales.conversaciones} conversaciones → ${totales.canonicas} canónicas · ${totales.partidas} partidas`);
console.log("Sin teléfonos ni nombres en esta salida. No se escribió nada.");
