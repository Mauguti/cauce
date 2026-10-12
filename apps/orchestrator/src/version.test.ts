import { afterEach, describe, expect, it } from "vitest";
import { leerGit, resolverVersion } from "./version.ts";
import { usarSalida } from "../src/log.ts";

const bitacora: string[] = [];
usarSalida((_n, l) => { bitacora.push(l); });
afterEach(() => { bitacora.length = 0; });

describe("versión desplegada", () => {
  it("manda git; una CAUCE_VERSION distinta se ignora y queda en bitácora", () => {
    expect(resolverVersion({ git: { hash: "d82e39c", sucio: false }, env: "ee67555" })).toBe("d82e39c");
    expect(bitacora.some((l) => l.includes("version.env_ignorada") && l.includes("env=ee67555") && l.includes("git=d82e39c"))).toBe(true);
  });

  it("si coincide no avisa; con cambios sin commitear lleva '+'", () => {
    expect(resolverVersion({ git: { hash: "d82e39c", sucio: false }, env: "d82e39c" })).toBe("d82e39c");
    expect(resolverVersion({ git: { hash: "d82e39c", sucio: true }, env: undefined })).toBe("d82e39c+");
    expect(bitacora).toEqual([]);
  });

  it("sin repositorio usa CAUCE_VERSION y, sin ella, 'dev'", () => {
    expect(resolverVersion({ git: null, env: " abc1234 " })).toBe("abc1234");
    expect(resolverVersion({ git: null, env: "" })).toBe("dev");
  });

  it("leerGit lee el HEAD real de este repositorio y no cuenta archivos sin seguimiento como suciedad", () => {
    const g = leerGit(new URL("../../..", import.meta.url).pathname);
    expect(g?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(leerGit("/")).toBeNull();
  });
});
