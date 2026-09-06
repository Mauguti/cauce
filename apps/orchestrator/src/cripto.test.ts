import { describe, expect, it } from "vitest";
import { Cripto, pista } from "./cripto.ts";

const cripto = new Cripto(Buffer.alloc(32, 3));

describe("Cripto", () => {
  it("cifra y descifra (round-trip), y el ciphertext no contiene el claro", () => {
    const secreto = "token-super-secreto-de-monday";
    const cifrado = cripto.cifrar(secreto);
    expect(cifrado).not.toContain(secreto);
    expect(cifrado.startsWith("gcm1:")).toBe(true);
    expect(cripto.descifrar(cifrado)).toBe(secreto);
  });

  it("cifrar la misma entrada da ciphertext distinto (IV aleatorio)", () => {
    expect(cripto.cifrar("x")).not.toBe(cripto.cifrar("x"));
  });

  it("descifrar con otra llave falla (autenticación GCM)", () => {
    const otro = new Cripto(Buffer.alloc(32, 9));
    expect(() => otro.descifrar(cripto.cifrar("x"))).toThrow();
  });

  it("cadena vacía va y vuelve como vacía", () => {
    expect(cripto.cifrar("")).toBe("");
    expect(cripto.descifrar("")).toBe("");
  });
});

describe("pista", () => {
  it("expone solo los últimos 4 caracteres", () => {
    expect(pista("abcdEFGH")).toBe("····EFGH");
    expect(pista("abc")).toBe("····");
  });
});
