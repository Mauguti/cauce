import { describe, expect, it } from "vitest";
import { Provisioning } from "./provisioning.ts";
import { RepositorioEnMemoria } from "./store.ts";
import type { Identidad } from "./firebase.ts";

const ana: Identidad = { uid: "uid-ana", email: "ana@we.build", nombre: "Ana" };

describe("Provisioning", () => {
  it("crea un tenant de prueba con caducidad y API key", async () => {
    const repo = new RepositorioEnMemoria();
    const prov = new Provisioning(repo);
    const { tenant, apiKey } = await prov.provisionar(ana);
    expect(tenant.plan).toBe("prueba");
    expect(tenant.pruebaExpiraEn).toBeTruthy();
    expect(apiKey).toMatch(/^[0-9a-f]{48}$/);
    // El tenant queda asociado al uid.
    expect(await repo.getTenantIdDeUsuario("uid-ana")).toBe(tenant.id);
  });

  it("es idempotente: segundo request del mismo uid NO crea otro tenant", async () => {
    const repo = new RepositorioEnMemoria();
    const prov = new Provisioning(repo);
    const a = await prov.provisionar(ana);
    const b = await prov.provisionar(ana);
    expect(b.tenant.id).toBe(a.tenant.id);
    expect((await repo.listTenants()).length).toBe(1);
    // La API key en claro solo se devuelve en el alta nueva.
    expect(a.apiKey).not.toBeNull();
    expect(b.apiKey).toBeNull();
  });

  it("CARRERA: dos requests concurrentes del mismo uid → un solo tenant", async () => {
    const repo = new RepositorioEnMemoria();
    const prov = new Provisioning(repo);
    const [a, b] = await Promise.all([
      prov.provisionar(ana),
      prov.provisionar(ana),
    ]);
    expect(a.tenant.id).toBe(b.tenant.id);
    expect((await repo.listTenants()).length).toBe(1);
  });

  it("usuarios distintos obtienen tenants distintos", async () => {
    const repo = new RepositorioEnMemoria();
    const prov = new Provisioning(repo);
    const a = await prov.provisionar(ana);
    const c = await prov.provisionar({ uid: "uid-caro", email: "c@x.mx", nombre: "Caro" });
    expect(a.tenant.id).not.toBe(c.tenant.id);
    expect((await repo.listTenants()).length).toBe(2);
  });
});
