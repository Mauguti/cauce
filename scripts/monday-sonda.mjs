#!/usr/bin/env node
/**
 * Sonda de SOLO LECTURA contra la API real de monday, para cerrar lo que no
 * se puede verificar sin cuenta:
 *   1. ¿La columna de subelementos (type `subtasks`) trae `boardIds` en sus
 *      settings? Decide si el anidado del selector funciona o se degrada.
 *   2. ¿Qué responde monday al pedir por id un tablero privado del que el
 *      usuario del token NO es miembro? (vacío o error, y con qué texto)
 *   3. Lista real de tableros con tipo y kind (para la captura).
 *
 * El token NUNCA va por argumentos ni por chat: se lee de la variable
 * MONDAY_TOKEN_PRUEBA (p. ej. desde apps/orchestrator/.env.local, que git
 * ignora). No imprime el token ni escribe nada en monday.
 *
 *   MONDAY_TOKEN_PRUEBA=… node scripts/monday-sonda.mjs [id-tablero-privado]
 */
const token = process.env.MONDAY_TOKEN_PRUEBA?.trim();
if (!token) {
  console.error("Falta MONDAY_TOKEN_PRUEBA en el entorno (ponla en apps/orchestrator/.env.local, no en el chat).");
  process.exit(2);
}
const ENDPOINT = process.env.MONDAY_ENDPOINT ?? "https://api.monday.com/v2";
const API_VERSION = process.env.MONDAY_API_VERSION ?? "2025-07";
const idPrivado = process.argv[2]?.trim() || null;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: token, "API-Version": API_VERSION }, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const CAMPOS = (settings) => `id name type board_kind workspace { name } columns (types: [subtasks]) { id type ${settings} }`;

console.log(`API-Version ${API_VERSION} · endpoint ${ENDPOINT}`);
let campoSettings = "settings_str";
let r = await gql(`query { boards (limit: 100, page: 1, state: active, order_by: used_at) { ${CAMPOS("settings_str")} } }`);
if (r.json?.errors && JSON.stringify(r.json.errors).includes("settings_str")) {
  console.log("settings_str: la API lo rechaza en esta versión → se reintenta con settings (JSON)");
  campoSettings = "settings";
  r = await gql(`query { boards (limit: 100, page: 1, state: active, order_by: used_at) { ${CAMPOS("settings")} } }`);
}
if (r.json?.errors || !r.json?.data) {
  console.error("boards falló:", r.status, JSON.stringify(r.json?.errors ?? r.json).slice(0, 600));
  process.exit(1);
}
const boards = r.json.data.boards ?? [];
console.log(`\n== 3) Lista real: ${boards.length} tableros (campo de settings usado: ${campoSettings})`);
console.table(boards.map((b) => ({ id: b.id, name: b.name.slice(0, 40), type: b.type, kind: b.board_kind, workspace: b.workspace?.name ?? null, colsSubtasks: (b.columns ?? []).length })));

console.log("\n== 1) ¿boardIds en los settings de la columna subtasks?");
let conColumna = 0, conBoardIds = 0;
for (const b of boards) {
  for (const c of b.columns ?? []) {
    conColumna += 1;
    let s = c.settings ?? null;
    if (typeof c.settings_str === "string") { try { s = JSON.parse(c.settings_str); } catch { s = c.settings_str; } }
    const ids = Array.isArray(s?.boardIds) ? s.boardIds : null;
    if (ids) conBoardIds += 1;
    console.log(`  tablero ${b.id} "${b.name.slice(0, 30)}" · columna ${c.id} · claves=${s && typeof s === "object" ? Object.keys(s).join(",") : typeof s} · boardIds=${ids ? JSON.stringify(ids) : "NO"}`);
  }
}
console.log(conColumna === 0 ? "  (ningún tablero con columna de subelementos en esta página)" : `  columnas subtasks: ${conColumna} · con boardIds: ${conBoardIds} → ${conBoardIds === conColumna ? "VERIFICADO: boardIds llega" : conBoardIds ? "PARCIAL" : "NO llega: el selector degrada al grupo 'Subelementos'"}`);

console.log("\n== 2) Tablero por id");
const probar = async (id, etiqueta) => {
  const q = await gql(`query ($ids: [ID!]) { boards (ids: $ids) { ${CAMPOS(campoSettings)} } }`, { ids: [id] });
  console.log(`  ${etiqueta} id=${id} → HTTP ${q.status} · boards=${JSON.stringify(q.json?.data?.boards ?? null)?.slice(0, 200)} · errors=${JSON.stringify(q.json?.errors ?? null)?.slice(0, 400)}`);
};
if (boards[0]) await probar(boards[0].id, "accesible");
await probar("1", "inexistente");
if (idPrivado) await probar(idPrivado, "privado sin acceso");
else console.log("  (pasa el id del tablero privado creado por otro usuario como primer argumento para capturar su respuesta)");
