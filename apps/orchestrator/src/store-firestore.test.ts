import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Firestore } from "@google-cloud/firestore";
import type { Instance, Message, Tenant } from "@cauce/core";
import { RepositorioFirestore } from "./store-firestore.ts";

/**
 * Integración contra el emulador de Firestore. Se omite si no está
 * corriendo (FIRESTORE_EMULATOR_HOST sin definir). Para correrla:
 *   firebase emulators:start --only firestore --project cauce-consola
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npm test -w @cauce/orchestrator
 */
const hayEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const tenant: Tenant = {
  id: "t-fs",
  nombre: "Firestore test",
  plan: "basico",
  estado: "activo",
  apiKeyHash: "a".repeat(64),
  creadoEn: "2026-09-06T00:00:00Z",
};

const instancia: Instance = {
  id: "i-fs",
  tenantId: "t-fs",
  transportType: "evolution",
  contenedorId: "cont-1",
  numero: null,
  estado: "connected",
  ultimoHeartbeat: null,
};

function mensaje(id: string, direccion: "in" | "out"): Message {
  return {
    id,
    tenantId: "t-fs",
    instanceId: "i-fs",
    direccion,
    telefono: "+5215500000000",
    cuerpo: `cuerpo ${id}`,
    estado: direccion === "in" ? "recibido" : "enviado",
    externalId: null,
    timestamp: `2026-09-06T00:00:0${id.slice(-1)}.000Z`,
  };
}

describe.skipIf(!hayEmulador)("RepositorioFirestore", () => {
  const db = new Firestore({ projectId: "cauce-consola" });

  beforeAll(async () => {
    // Limpia lo que pudiera haber quedado de una corrida previa.
    for (const col of ["instances", "messages"]) {
      const snap = await db.collection(`tenants/t-fs/${col}`).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    await db.doc("tenants/t-fs").delete().catch(() => {});
  });

  afterAll(async () => {
    await db.terminate();
  });

  it("persiste tenant, instancia y mensajes, y filtra por instancia", async () => {
    const repo = new RepositorioFirestore(db);
    await repo.saveTenant(tenant);
    await repo.saveInstance(instancia);
    await repo.saveMessage(mensaje("m1", "out"));
    await repo.saveMessage(mensaje("m2", "in"));

    expect(await repo.getTenant("t-fs")).toMatchObject({ id: "t-fs", apiKeyHash: "a".repeat(64) });
    expect((await repo.listTenants()).some((t) => t.id === "t-fs")).toBe(true);
    expect(await repo.getInstance("t-fs", "i-fs")).toMatchObject({ contenedorId: "cont-1" });
    const msgs = await repo.listMessages("t-fs", "i-fs");
    expect(msgs.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("saveMessage es upsert por id (la cola reescribe el mismo mensaje)", async () => {
    const repo = new RepositorioFirestore(db);
    await repo.saveMessage({ ...mensaje("m1", "out"), estado: "encolado" });
    await repo.saveMessage({ ...mensaje("m1", "out"), estado: "enviado", externalId: "ext-9" });
    const msgs = await repo.listMessages("t-fs", "i-fs");
    const m1 = msgs.filter((m) => m.id === "m1");
    expect(m1).toHaveLength(1);
    expect(m1[0]).toMatchObject({ estado: "enviado", externalId: "ext-9" });
  });

  it("el historial y los tenants sobreviven a un 'reinicio' del proceso", async () => {
    // Proceso A escribe.
    const repoA = new RepositorioFirestore(db);
    await repoA.saveTenant(tenant);
    await repoA.saveInstance(instancia);
    await repoA.saveMessage(mensaje("m1", "out"));
    await repoA.saveMessage(mensaje("m2", "in"));

    // Proceso B: cliente Firestore nuevo, sin estado en memoria.
    const dbB = new Firestore({ projectId: "cauce-consola" });
    const repoB = new RepositorioFirestore(dbB);
    try {
      expect((await repoB.listTenants()).some((t) => t.id === "t-fs")).toBe(true);
      const msgs = await repoB.listMessages("t-fs", "i-fs");
      expect(msgs.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
      expect(await repoB.getInstance("t-fs", "i-fs")).not.toBeNull();
    } finally {
      await dbB.terminate();
    }
  });

  it("deleteInstance borra solo la instancia, no el historial", async () => {
    const repo = new RepositorioFirestore(db);
    await repo.saveInstance(instancia);
    await repo.saveMessage(mensaje("m1", "out"));
    await repo.deleteInstance("t-fs", "i-fs");
    expect(await repo.getInstance("t-fs", "i-fs")).toBeNull();
    // Los mensajes son subcolección del tenant, no de la instancia: quedan.
    expect((await repo.listMessages("t-fs", "i-fs")).length).toBeGreaterThan(0);
  });
});
