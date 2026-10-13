#!/usr/bin/env node
/**
 * Copia el teléfono de una columna espejo (mirror) a una columna Phone en
 * monday. Sustituye al script suelto de Downloads (13-oct-2026) con tres
 * cambios de fondo:
 *
 * 1. MÁS DE UN VALOR en el espejo → estado "revisar": no se escribe, va al
 *    CSV y una persona decide. monday no garantiza el orden; tomar el
 *    primero era mandar cobranza al contacto equivocado.
 * 2. El token NUNCA va en el archivo: se lee de MONDAY_TOKEN_PRUEBA (o
 *    MONDAY_TOKEN) del entorno. Nada de pegarlo aquí.
 * 3. Por defecto es ensayo (no escribe). Solo escribe con --aplicar.
 *    Siempre deja un CSV con el resultado por item.
 *
 * Uso (Node 22+):
 *   MONDAY_TOKEN=… node --experimental-strip-types scripts/copiar-espejo-telefono.mjs \
 *     --board 8438932699 --origen lookup_mm82vgyw --destino phone_mm827znv [--aplicar] [--sobrescribir] [--lada 52]
 */
import { writeFileSync } from "node:fs";
import { clasificar, filaCsv } from "../apps/orchestrator/src/monday/espejo-telefono.ts";

const args = process.argv.slice(2);
const opcion = (nombre, def = null) => { const i = args.indexOf(`--${nombre}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const bandera = (nombre) => args.includes(`--${nombre}`);

const TOKEN = (process.env.MONDAY_TOKEN ?? process.env.MONDAY_TOKEN_PRUEBA ?? "").trim();
const BOARD = opcion("board");
const SRC = opcion("origen");
const DST = opcion("destino");
const LADA = opcion("lada", "52");
const PAIS = opcion("pais", "MX");
const APLICAR = bandera("aplicar");
const SOBRESCRIBIR = bandera("sobrescribir");
if (!TOKEN) { console.error("Falta MONDAY_TOKEN en el entorno (no lo pegues en el archivo ni en el chat)."); process.exit(2); }
if (!BOARD || !SRC || !DST) { console.error("Uso: --board <id> --origen <columna espejo> --destino <columna phone> [--aplicar] [--sobrescribir]"); process.exit(2); }

async function gql(query, variables = {}) {
  const r = await fetch("https://api.monday.com/v2", { method: "POST", headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": process.env.MONDAY_API_VERSION ?? "2025-07" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors || j.error_message) throw new Error(JSON.stringify(j.errors ?? j.error_message));
  return j.data;
}

const CAMPOS = `cursor items { id name column_values(ids: ["${SRC}", "${DST}"]) { id text ... on MirrorValue { display_value } } }`;

const filas = [filaCsv(["item_id", "nombre", "estado", "telefono_escrito", "valores_del_espejo", "destino_antes", "motivo"])];
const conteo = { copiar: 0, revisar: 0, sin_valor: 0, ya_tiene: 0, error: 0 };
let pagina = (await gql(`query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 200) { ${CAMPOS} } } }`, { b: [BOARD] })).boards[0].items_page;
let total = 0;
console.log(`${APLICAR ? "APLICANDO" : "ENSAYO (sin escribir; usa --aplicar)"} · tablero ${BOARD} · ${SRC} → ${DST}`);
while (true) {
  for (const item of pagina.items) {
    total += 1;
    const src = item.column_values.find((c) => c.id === SRC);
    const dst = item.column_values.find((c) => c.id === DST);
    const c = clasificar({ espejo: src?.display_value || src?.text, destinoActual: dst?.text, sobrescribir: SOBRESCRIBIR, ladaDefault: LADA });
    let estado = c.estado;
    let motivo = c.motivo;
    if (c.estado === "copiar" && APLICAR) {
      try {
        await gql(`mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`, { b: BOARD, i: item.id, v: JSON.stringify({ [DST]: { phone: c.telefono, countryShortName: PAIS } }) });
        await new Promise((r) => setTimeout(r, 150));
      } catch (err) {
        estado = "error";
        motivo = err instanceof Error ? err.message.slice(0, 200) : String(err);
      }
    }
    conteo[estado] += 1;
    if (estado === "revisar" || estado === "error") console.log(`  ${estado.toUpperCase()} · ${item.id} · ${item.name} · espejo=[${c.valores.join(" | ")}] · ${motivo}`);
    else if (estado === "copiar") console.log(`  ${APLICAR ? "copiado" : "copiaría"} · ${item.id} · ${item.name} → ${c.telefono}`);
    filas.push(filaCsv([item.id, item.name, estado, c.estado === "copiar" ? c.telefono : "", c.valores.join(" | "), dst?.text ?? "", motivo]));
  }
  if (!pagina.cursor) break;
  pagina = (await gql(`query ($c: String!) { next_items_page(limit: 200, cursor: $c) { ${CAMPOS} } }`, { c: pagina.cursor })).next_items_page;
}
const salida = `espejo-telefono-${BOARD}-${new Date().toISOString().replace(/[:.]/g, "-")}${APLICAR ? "" : "-ensayo"}.csv`;
writeFileSync(salida, "﻿" + filas.join("\n"), "utf8");
console.log(`\nTotal ${total} · ${APLICAR ? "copiados" : "copiaría"} ${conteo.copiar} · REVISAR ${conteo.revisar} · sin valor ${conteo.sin_valor} · ya tenían ${conteo.ya_tiene} · errores ${conteo.error}\nCSV: ${salida}`);
if (conteo.revisar > 0) console.log(`⚠️  ${conteo.revisar} item(s) con más de un teléfono: NO se escribieron. Decide en el CSV y corrige en monday a mano.`);
process.exit(conteo.error > 0 ? 1 : 0);
