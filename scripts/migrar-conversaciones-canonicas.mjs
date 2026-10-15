#!/usr/bin/env node
/**
 * Migración de conversaciones partidas por la forma del teléfono (+52 vs
 * +521) a la llave canónica (forma del JID: 521 + 10 dígitos para México).
 *
 * Tres modos:
 *   (sin bandera)        REPORTE: cuenta y clasifica, no escribe nada.
 *   --aplicar            Une SOLO la categoría segura y retira el doc no
 *                        canónico, dejando un respaldo JSON en el cwd.
 *   --revertir <json>    Restaura los docs retirados desde ese respaldo.
 *
 * Categoría segura: a lo sumo un doc del grupo tiene entrantes; los vínculos
 * al CRM (mondayItemId / bitrixEntidad) no se contradicen; ningún doc tiene
 * traspaso sin atender, cita pendiente, ventana humana viva ni chat de
 * Bitrix duplicado. Todo lo demás se lista en el respaldo (ids, no se
 * imprime) y se deja como está para que lo decida una persona.
 *
 * El doc que sobrevive es el de la llave canónica (se crea si no existe);
 * recibe lo que le falte de los demás. Los mensajes NO se tocan: se guardan
 * como vinieron y el código los consulta por todas las formas equivalentes.
 *
 * ORDEN: primero el código (telefonoCanonico en producción), después esto.
 * Si se corre antes, el código viejo vuelve a partirlas.
 *
 *   sudo bash -c 'set -a; . /etc/factory.env; set +a; cd /opt/factory/apps/orchestrator && \
 *     node _migrar-conversaciones-tmp.mjs [--tenant <id>] [--aplicar | --revertir <respaldo.json>]'
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
const soloTenant = opcion("tenant");
const APLICAR = args.includes("--aplicar");
const REVERTIR = opcion("revertir");
const databaseId = process.env.CAUCE_FIRESTORE_DB?.trim() || undefined;
const db = new Firestore(databaseId ? { databaseId } : {});

/** Misma regla que telefonoCanonico de @cauce/core para México; otros países, dígitos tal cual. */
function canonico(tel) {
  const d = String(tel ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("52")) return `521${d.slice(2)}`;
  return d;
}

if (REVERTIR) {
  const respaldo = JSON.parse(readFileSync(REVERTIR, "utf8"));
  let restaurados = 0;
  for (const r of respaldo.retirados) {
    await db.doc(r.ruta).set(r.doc);
    restaurados += 1;
  }
  for (const s of respaldo.sobrevivientesAntes) {
    if (s.doc) await db.doc(s.ruta).set(s.doc); else await db.doc(s.ruta).delete();
  }
  console.log(`Revertido: ${restaurados} docs restaurados y ${respaldo.sobrevivientesAntes.length} sobrevivientes regresados a su estado previo.`);
  process.exit(0);
}

const ahora = new Date().toISOString();
const tenants = soloTenant ? [soloTenant] : (await db.collection("tenants").get()).docs.map((d) => d.id);
const respaldo = { en: ahora, base: databaseId ?? "(default)", retirados: [], sobrevivientesAntes: [], manuales: [] };
const tot = { tenants: 0, grupos: 0, seguras: 0, manuales: 0, unidas: 0 };

for (const t of tenants) {
  const instancias = (await db.collection(`tenants/${t}/instances`).get()).docs.map((d) => d.id);
  const grupos = new Map();
  for (const inst of instancias) {
    const snap = await db.collection(`tenants/${t}/instances/${inst}/conversaciones`).get();
    for (const d of snap.docs) {
      const doc = d.data();
      const k = `${inst}/${canonico(doc.telefono ?? d.id)}`;
      grupos.set(k, [...(grupos.get(k) ?? []), { inst, id: d.id, ruta: d.ref.path, doc }]);
    }
  }
  const partidas = [...grupos.entries()].filter(([, g]) => g.length > 1);
  if (partidas.length === 0) continue;
  tot.tenants += 1;
  let seguras = 0, manuales = 0, unidas = 0;
  for (const [k, g] of partidas) {
    tot.grupos += 1;
    const canon = k.split("/")[1];
    const inst = k.split("/")[0];
    const conEntrantes = g.filter((x) => x.doc.primerContactoEn);
    const monday = new Set(g.map((x) => x.doc.mondayItemId).filter(Boolean));
    const bitrix = new Set(g.map((x) => (x.doc.bitrixEntidad ? `${x.doc.bitrixEntidad.tipo}:${x.doc.bitrixEntidad.id}` : null)).filter(Boolean));
    const chats = g.filter((x) => x.doc.bitrixOpenLine?.chatId).length;
    const bloqueada = g.some((x) => (x.doc.traspaso && !x.doc.traspaso.atendidoEn) || x.doc.citaPendiente || (x.doc.humanaHasta && x.doc.humanaHasta > ahora));
    const segura = g.length === 2 && conEntrantes.length <= 1 && monday.size <= 1 && bitrix.size <= 1 && chats <= 1 && !bloqueada;
    if (!segura) {
      manuales += 1; tot.manuales += 1;
      respaldo.manuales.push({ tenant: t, instancia: inst, canonico: canon, docs: g.map((x) => x.id), motivo: { docs: g.length, conEntrantes: conEntrantes.length, mondayDistintos: monday.size, bitrixDistintas: bitrix.size, chatsBitrix: chats, bloqueada } });
      continue;
    }
    seguras += 1; tot.seguras += 1;
    if (!APLICAR) continue;
    // Sobrevive el doc canónico (se crea si no existe); los demás se funden en él.
    const sobreviviente = g.find((x) => x.id === canon) ?? null;
    const otros = g.filter((x) => x.id !== canon);
    const base = sobreviviente?.doc ?? { tenantId: t, instanceId: inst, telefono: canon, nombre: null, primerContactoEn: null, ultimoEntranteEn: null, mondayItemId: null, bitrixEntidad: null };
    const fusion = { ...base, telefono: canon };
    for (const o of otros) {
      const d = o.doc;
      for (const campo of ["nombre", "mondayItemId", "bitrixEntidad", "bitrixOpenLine", "atribucion", "traspaso", "citaPendiente", "humanaHasta", "autoPausadaHasta", "cortacircuitos", "ultimaAutoRespuesta", "avisoSuspensionEn"]) {
        if ((fusion[campo] === null || fusion[campo] === undefined) && d[campo] !== null && d[campo] !== undefined) fusion[campo] = d[campo];
      }
      if (d.primerContactoEn && (!fusion.primerContactoEn || d.primerContactoEn < fusion.primerContactoEn)) fusion.primerContactoEn = d.primerContactoEn;
      if (d.ultimoEntranteEn && (!fusion.ultimoEntranteEn || d.ultimoEntranteEn > fusion.ultimoEntranteEn)) fusion.ultimoEntranteEn = d.ultimoEntranteEn;
      if (Array.isArray(d.autoRespuestas)) fusion.autoRespuestas = [...(fusion.autoRespuestas ?? []), ...d.autoRespuestas].sort().slice(-20);
    }
    const rutaCanon = `tenants/${t}/instances/${inst}/conversaciones/${canon}`;
    respaldo.sobrevivientesAntes.push({ ruta: rutaCanon, doc: sobreviviente?.doc ?? null });
    await db.doc(rutaCanon).set(fusion);
    for (const o of otros) {
      respaldo.retirados.push({ ruta: o.ruta, doc: o.doc });
      await db.doc(o.ruta).delete();
    }
    unidas += 1; tot.unidas += 1;
  }
  console.log(`tenant ${t}: partidas ${partidas.length} · seguras ${seguras} · manuales ${manuales}${APLICAR ? ` · UNIDAS ${unidas}` : ""}`);
}

const archivo = `migracion-conversaciones-${ahora.replace(/[:.]/g, "-")}${APLICAR ? "" : "-reporte"}.json`;
writeFileSync(archivo, JSON.stringify(respaldo, null, 2));
console.log(`\n${APLICAR ? "APLICADO" : "REPORTE (nada escrito)"} · tenants con partidas: ${tot.tenants} · grupos: ${tot.grupos} · seguras: ${tot.seguras} · manuales: ${tot.manuales}${APLICAR ? ` · unidas: ${tot.unidas}` : ""}`);
console.log(`Respaldo/detalle (con ids; NO compartir): ${archivo}${APLICAR ? `\nPara revertir: node <este script> --revertir ${archivo}` : ""}`);
