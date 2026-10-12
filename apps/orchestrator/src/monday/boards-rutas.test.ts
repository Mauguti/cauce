import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "../app.ts";
import { hashApiKey } from "../auth.ts";
import { RepositorioEnMemoria } from "../store.ts";

const KEY = "key-tenant-a-0000000000000000";
const conKey = { headers: { "x-api-key": KEY, "content-type": "application/json" } };

function levantar() {
  const repo = new RepositorioEnMemoria({ tenants: [{ id: "a", nombre: "A", plan: "estandar", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-05T00:00:00Z" }] });
  const monday = {
    verConfig: async () => null,
    listarBoards: async (_t: string, pagina: number) => ({ boards: pagina === 1 ? [{ id: "1", name: "Cobranza", tipo: "board", kind: "public", workspace: null, subitemsBoardIds: [] }] : [], pagina, hayMas: pagina === 1 }),
    obtenerBoard: async (_t: string, id: string) => (id === "1" ? { id: "1", name: "Cobranza", tipo: "board", kind: "public", workspace: null, subitemsBoardIds: [] } : id === "500" ? (() => { throw new Error("monday API 200: [{\"message\":\"You don't have permission to access this board\"}]"); })() : null),
  };
  const server = crearApp(repo, undefined, { monday: monday as any }).listen(0);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cerrar: () => server.close() };
}

describe("rutas de boards de monday", () => {
  it("probar devuelve la primera página con hayMas; boards pagina por demanda", async () => {
    const { base, cerrar } = levantar();
    try {
      const p = await fetch(`${base}/api/tenants/a/conectores/monday/probar`, { ...conKey, method: "POST", body: JSON.stringify({ apiToken: "tok" }) }).then((r) => r.json());
      expect(p).toMatchObject({ ok: true, pagina: 1, hayMas: true });
      expect(p.boards[0].name).toBe("Cobranza");
      const p2 = await fetch(`${base}/api/tenants/a/conectores/monday/boards`, { ...conKey, method: "POST", body: JSON.stringify({ apiToken: "tok", pagina: 2 }) }).then((r) => r.json());
      expect(p2).toEqual({ boards: [], pagina: 2, hayMas: false });
    } finally {
      cerrar();
    }
  });

  it("board por id: 404 con mensaje que explica lo del tablero privado, tanto si monday devuelve vacío como si devuelve error de permisos; ID no numérico 400", async () => {
    const { base, cerrar } = levantar();
    try {
      const ok = await fetch(`${base}/api/tenants/a/conectores/monday/board`, { ...conKey, method: "POST", body: JSON.stringify({ apiToken: "tok", boardId: " 1 " }) });
      expect(ok.status).toBe(200);
      for (const id of ["999", "500"]) {
        const r = await fetch(`${base}/api/tenants/a/conectores/monday/board`, { ...conKey, method: "POST", body: JSON.stringify({ apiToken: "tok", boardId: id }) });
        expect(r.status).toBe(404);
        const c = await r.json();
        expect(c.motivo).toBe("sin_acceso_o_inexistente");
        expect(c.error).toContain("Puede ser privado");
        expect(c.error).toContain("debe ser miembro de ese tablero");
        expect(c.error).toContain("El ID no salta permisos");
      }
      const malo = await fetch(`${base}/api/tenants/a/conectores/monday/board`, { ...conKey, method: "POST", body: JSON.stringify({ apiToken: "tok", boardId: "abc" }) });
      expect(malo.status).toBe(400);
      expect((await malo.json()).error).toContain("solo dígitos");
    } finally {
      cerrar();
    }
  });
});
