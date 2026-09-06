import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Cifrado simétrico de credenciales en reposo (AES-256-GCM). La llave
 * sale de CAUCE_CRYPTO_KEY (entorno del servicio, nunca en el repo); se
 * deriva con scrypt para aceptar cualquier cadena de longitud. Sin la
 * variable se usa una llave de desarrollo insegura, con aviso.
 *
 * Formato del ciphertext: base64(iv[12] ‖ tag[16] ‖ datos).
 */
const PREFIJO = "gcm1:";

function derivarLlave(): Buffer {
  const secreto = process.env.CAUCE_CRYPTO_KEY;
  if (!secreto) {
    console.warn(
      "CAUCE_CRYPTO_KEY no definida: credenciales cifradas con llave de desarrollo INSEGURA",
    );
  }
  return scryptSync(secreto ?? "cauce-dev-inseguro", "cauce-cripto-sal", 32);
}

export class Cripto {
  readonly #llave: Buffer;

  constructor(llave: Buffer = derivarLlave()) {
    this.#llave = llave;
  }

  cifrar(texto: string): string {
    if (texto === "") return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#llave, iv);
    const datos = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIJO + Buffer.concat([iv, tag, datos]).toString("base64");
  }

  descifrar(cifrado: string): string {
    if (cifrado === "") return "";
    if (!cifrado.startsWith(PREFIJO)) {
      throw new Error("formato de ciphertext desconocido");
    }
    const bruto = Buffer.from(cifrado.slice(PREFIJO.length), "base64");
    const iv = bruto.subarray(0, 12);
    const tag = bruto.subarray(12, 28);
    const datos = bruto.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.#llave, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]).toString(
      "utf8",
    );
  }
}

/** Últimos 4 caracteres, para que el usuario reconozca la credencial. */
export function pista(secreto: string): string {
  return secreto.length <= 4 ? "····" : `····${secreto.slice(-4)}`;
}
