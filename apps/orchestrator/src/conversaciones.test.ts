import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { RepositorioEnMemoria } from "./store.ts";

const KEY = "key-conv-0000000000000000000000";
function repoConTenant() {
  return new RepositorioEnMemoria({
    tenants: [{ id: "t", nombre: "T", plan: "estandar", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-07T00:00:00Z" }],
  });
}

describe("conversaciones: nombre del contacto y listado", () => {
  it("registrarEntrante guarda el nombre y lo conserva si luego llega vacío", async () => {
    const repo = repoConTenant();
    await repo.registrarEntrante("t", "i1", "5215500000000", "2026-09-07T10:00:00Z", "Ana López");
    let c = await repo.getConversacion("t", "i1", "5215500000000");
    expect(c!.nombre).toBe("Ana López");
    // Un entrante posterior sin pushName no borra el nombre ya conocido.
    await repo.registrarEntrante("t", "i1", "5215500000000", "2026-09-07T11:00:00Z", null);
    c = await repo.getConversacion("t", "i1", "5215500000000");
    expect(c!.nombre).toBe("Ana López");
  });

  it("listConversaciones devuelve solo las del tenant", async () => {
    const repo = repoConTenant();
    await repo.registrarEntrante("t", "i1", "5215511112222", "2026-09-07T10:00:00Z", "Beto");
    await repo.vincularMonday("t", "i1", "5215533334444", "item-99");
    await repo.registrarEntrante("otro", "i9", "5215599998888", "2026-09-07T10:00:00Z", "Ajeno");
    const lista = await repo.listConversaciones("t");
    expect(lista).toHaveLength(2);
    expect(lista.map((c) => c.telefono).sort()).toEqual(["5215511112222", "5215533334444"]);
    expect(lista.find((c) => c.telefono === "5215533334444")!.mondayItemId).toBe("item-99");
  });

  it("GET /conversaciones expone el listado al tenant dueño de la key", async () => {
    const repo = repoConTenant();
    await repo.registrarEntrante("t", "i1", "5215511112222", "2026-09-07T10:00:00Z", "Beto");
    const server = crearApp(repo).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/tenants/t/conversaciones`, { headers: { "x-api-key": KEY } });
      expect(res.status).toBe(200);
      const lista = await res.json();
      expect(lista).toEqual([
        expect.objectContaining({ telefono: "5215511112222", nombre: "Beto" }),
      ]);
    } finally {
      server.close();
    }
  });
});
