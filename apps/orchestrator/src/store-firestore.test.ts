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
  plan: "estandar",
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

  it("registrarEntrante: primer contacto y luego actualiza", async () => {
    const repo = new RepositorioFirestore(db);
    const tel = `52551${Date.now() % 1000000}`;
    const a = await repo.registrarEntrante("t-fs", "i-fs", tel, "2026-09-07T10:00:00Z");
    expect(a.esPrimerContacto).toBe(true);
    const b = await repo.registrarEntrante("t-fs", "i-fs", tel, "2026-09-07T10:05:00Z");
    expect(b.esPrimerContacto).toBe(false);
    expect(b.conversacion.primerContactoEn).toBe("2026-09-07T10:00:00Z");
    expect(b.conversacion.ultimoEntranteEn).toBe("2026-09-07T10:05:00Z");
  });

  it("CARRERA: entrantes concurrentes del mismo número → un solo primer contacto", async () => {
    const repo = new RepositorioFirestore(db);
    const tel = `52559${Date.now() % 1000000}`;
    // Las transacciones sobre el mismo doc se serializan (Firestore
    // reintenta el perdedor); por eso 5 concurrentes tardan varios
    // segundos. Lo que importa: exactamente una ve el primer contacto.
    const resultados = await Promise.all(
      Array.from({ length: 5 }, (_, k) =>
        repo.registrarEntrante("t-fs", "i-fs", tel, `2026-09-07T11:00:0${k}Z`),
      ),
    );
    const primeros = resultados.filter((r) => r.esPrimerContacto).length;
    expect(primeros).toBe(1);
  }, 30_000);

  it("vincularMonday hace merge sin pisar el estado de la conversación", async () => {
    const repo = new RepositorioFirestore(db);
    const tel = `52558${Date.now() % 1000000}`;
    await repo.registrarEntrante("t-fs", "i-fs", tel, "2026-09-07T12:00:00Z");
    await repo.vincularMonday("t-fs", "i-fs", tel, "item-99");
    const conv = await repo.getConversacion("t-fs", "i-fs", tel);
    expect(conv?.mondayItemId).toBe("item-99");
    // El primerContactoEn del entrante previo NO se perdió.
    expect(conv?.primerContactoEn).toBe("2026-09-07T12:00:00Z");
  });

  it("la conversación (y su vínculo) sobrevive a un 'reinicio' del proceso", async () => {
    const repo = new RepositorioFirestore(db);
    const tel = `52557${Date.now() % 1000000}`;
    await repo.registrarEntrante("t-fs", "i-fs", tel, "2026-09-07T13:00:00Z");
    await repo.vincularMonday("t-fs", "i-fs", tel, "item-77");

    const dbB = new Firestore({ projectId: "cauce-consola" });
    const repoB = new RepositorioFirestore(dbB);
    try {
      const conv = await repoB.getConversacion("t-fs", "i-fs", tel);
      expect(conv?.mondayItemId).toBe("item-77");
    } finally {
      await dbB.terminate();
    }
  });

  it("disparadores: se guardan y se leen como lista ordenable", async () => {
    const repo = new RepositorioFirestore(db);
    await repo.saveDisparadores("t-fs", [
      { id: "a", prioridad: 5, tipo: "cualquiera", activo: true, respuesta: "hola" },
    ]);
    const lista = await repo.getDisparadores("t-fs");
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ id: "a", tipo: "cualquiera" });
  });

  it("provisionarTenant es idempotente bajo concurrencia real (transacción)", async () => {
    const repo = new RepositorioFirestore(db);
    const uid = `uid-conc-${Date.now()}`;
    let fabricado = 0;
    const fabrica = () => {
      fabricado += 1;
      return {
        id: `${uid}-${fabricado}-${Math.random().toString(36).slice(2, 6)}`,
        nombre: "Concurrente",
        plan: "prueba" as const,
        estado: "activo" as const,
        apiKeyHash: "b".repeat(64),
        pruebaExpiraEn: new Date(Date.now() + 1e9).toISOString(),
        creadoEn: new Date().toISOString(),
      };
    };
    // 5 altas concurrentes del MISMO uid.
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => repo.provisionarTenant(uid, fabrica)),
    );
    const ids = new Set(resultados.map((t) => t.id));
    expect(ids.size).toBe(1); // todos apuntan al mismo tenant
    expect(await repo.getTenantIdDeUsuario(uid)).toBe([...ids][0]);
  }, 30_000);
});
