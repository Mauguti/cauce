import { describe, expect, it } from "vitest";
import { ClienteMonday } from "./cliente.ts";

/** Fetch falso: responde según la consulta GraphQL que llega. */
function clienteCon(responder: (query: string, variables: any) => any) {
  const consultas: { query: string; variables: any }[] = [];
  const fetchFalso = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    consultas.push(body);
    const r = responder(body.query, body.variables);
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { cliente: new ClienteMonday("token", fetchFalso), consultas };
}

const BOARDS = [
  { id: 1, name: "Cobranza", type: "board", board_kind: "public", workspace: { name: "Principal" }, columns: [{ id: "subitems", type: "subtasks", settings_str: '{"allowMultipleItems":true,"itemTypeName":"Subelemento","displayType":"BOARD_INLINE","boardIds":[101]}' }] },
  { id: 101, name: "Subitems of Cobranza", type: "sub_items_board", board_kind: "public", workspace: { name: "Principal" }, columns: [] },
  { id: 2, name: "Ventas", type: "board", board_kind: "private", workspace: null, columns: [] },
  { id: 3, name: "Doc", type: "document", board_kind: "share", workspace: { name: "Principal" }, columns: [] },
];

describe("ClienteMonday · boards", () => {
  it("lista con tipo, kind, workspace y los ids de subelementos leídos de settings_str; pagina con hayMas", async () => {
    const { cliente, consultas } = clienteCon((q, v) => ({ data: { boards: v.page === 1 ? BOARDS : [] } }));
    const p1 = await cliente.listarBoards(1, 4);
    expect(p1.hayMas).toBe(true);
    expect(p1.boards[0]).toEqual({ id: "1", name: "Cobranza", tipo: "board", kind: "public", workspace: "Principal", subitemsBoardIds: ["101"] });
    expect(p1.boards[1]).toMatchObject({ id: "101", tipo: "sub_items_board", subitemsBoardIds: [] });
    expect(p1.boards[2]).toMatchObject({ id: "2", kind: "private", workspace: null });
    expect(p1.boards[3]).toMatchObject({ tipo: "document" });
    expect(consultas[0]!.query).toContain("columns (types: [subtasks])");
    expect(consultas[0]!.query).toContain("order_by: used_at");
    const p2 = await cliente.listarBoards(2, 4);
    expect(p2).toEqual({ boards: [], pagina: 2, hayMas: false });
  });

  it("si la versión de la API ya no conoce settings_str, reintenta con settings (JSON)", async () => {
    const { cliente, consultas } = clienteCon((q) =>
      q.includes("settings_str")
        ? { errors: [{ message: "Field 'settings_str' doesn't exist on type 'Column'" }] }
        : { data: { boards: [{ id: 1, name: "Cobranza", type: "board", board_kind: "public", columns: [{ id: "s", type: "subtasks", settings: { boardIds: [101, 102] } }] }] } });
    const p = await cliente.listarBoards();
    expect(p.boards[0]!.subitemsBoardIds).toEqual(["101", "102"]);
    expect(consultas).toHaveLength(2);
  });

  it("obtenerBoard: null cuando monday no lo devuelve (privado sin acceso o inexistente); otros errores se propagan", async () => {
    const { cliente } = clienteCon((_q, v) => ({ data: { boards: v.ids?.[0] === "2" ? [BOARDS[2]] : [] } }));
    expect(await cliente.obtenerBoard("999")).toBeNull();
    expect(await cliente.obtenerBoard("2")).toMatchObject({ id: "2", name: "Ventas", kind: "private" });
    const roto = clienteCon(() => ({ errors: [{ message: "Not Authenticated" }] }));
    await expect(roto.cliente.obtenerBoard("2")).rejects.toThrow(/Not Authenticated/);
  });
});
