import { describe, expect, it } from "vitest";
import { opcionesFirestoreDesdeEnv } from "./store-firestore.ts";

describe("opcionesFirestoreDesdeEnv", () => {
  it("sin variables no fuerza proyecto ni base (comportamiento de siempre)", () => {
    expect(opcionesFirestoreDesdeEnv({})).toEqual({});
  });

  it("CAUCE_FIRESTORE_DB fija la base con nombre", () => {
    expect(opcionesFirestoreDesdeEnv({ CAUCE_FIRESTORE_DB: "factory" })).toEqual({
      databaseId: "factory",
    });
  });

  it("una variable vacía o solo espacios cuenta como no definida", () => {
    expect(opcionesFirestoreDesdeEnv({ CAUCE_FIRESTORE_DB: "" })).toEqual({});
    expect(opcionesFirestoreDesdeEnv({ CAUCE_FIRESTORE_DB: "   " })).toEqual({});
  });

  it("FIRESTORE_PROJECT_ID sigue funcionando y se combina con la base", () => {
    expect(
      opcionesFirestoreDesdeEnv({
        FIRESTORE_PROJECT_ID: "digsol-fabrica-de-empleados",
        CAUCE_FIRESTORE_DB: "factory",
      }),
    ).toEqual({ projectId: "digsol-fabrica-de-empleados", databaseId: "factory" });
  });
});
