import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AlmacenAdjuntos, firmarUrl, verificarFirma } from "./almacen.ts";

const LLAVE = Buffer.alloc(32, 7);

let tempDir: string;
let almacen: AlmacenAdjuntos;

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), "cauce-adjuntos-"));
  almacen = new AlmacenAdjuntos({ directorio: tempDir, llave: LLAVE });
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("AlmacenAdjuntos", () => {
  it("guarda, lee y borra un adjunto", async () => {
    await setup();
    const contenido = Buffer.from("imagen-de-prueba");
    const adjunto = await almacen.guardar("t1", "i1", "m1", contenido, {
      nombre: "foto.jpg",
      tipoMime: "image/jpeg",
    });

    expect(adjunto).not.toBeNull();
    expect(adjunto!.nombre).toBe("foto.jpg");
    expect(adjunto!.tipoMime).toBe("image/jpeg");
    expect(adjunto!.tamano).toBe(contenido.length);
    expect(adjunto!.ruta).toContain("t1/i1/m1/");
    expect(adjunto!.ruta).toMatch(/\.jpg$/);

    const leido = await almacen.leer(adjunto!.ruta);
    expect(leido).toEqual(contenido);

    expect(await almacen.borrar(adjunto!.ruta)).toBe(true);
    expect(await almacen.leer(adjunto!.ruta)).toBeNull();
    expect(await almacen.borrar(adjunto!.ruta)).toBe(false);
  });

  it("rechaza un archivo que excede 20 MB", async () => {
    await setup();
    const grande = Buffer.alloc(21 * 1024 * 1024);
    const adjunto = await almacen.guardar("t1", "i1", "m1", grande, {
      nombre: "video.mp4",
      tipoMime: "video/mp4",
    });
    expect(adjunto).toBeNull();
  });

  it("calcula el uso por tenant", async () => {
    await setup();
    const a = Buffer.alloc(1000);
    const b = Buffer.alloc(2000);

    await almacen.guardar("t1", "i1", "m1", a, { nombre: "a.jpg", tipoMime: "image/jpeg" });
    await almacen.guardar("t1", "i1", "m2", b, { nombre: "b.png", tipoMime: "image/png" });

    const uso = await almacen.usoPorTenant("t1");
    expect(uso).toBe(3000);

    const usoVacio = await almacen.usoPorTenant("t-inexistente");
    expect(usoVacio).toBe(0);
  });
});

describe("URL firmada", () => {
  it("firma y verifica (round-trip)", () => {
    const token = firmarUrl("t1/i1/m1/abc.jpg", LLAVE, 1);
    const ruta = verificarFirma(token, LLAVE);
    expect(ruta).toBe("t1/i1/m1/abc.jpg");
  });

  it("rechaza firma con llave incorrecta", () => {
    const token = firmarUrl("t1/i1/m1/abc.jpg", LLAVE, 1);
    const otraLlave = Buffer.alloc(32, 9);
    expect(verificarFirma(token, otraLlave)).toBeNull();
  });

  it("rechaza firma expirada", () => {
    const token = firmarUrl("t1/i1/m1/abc.jpg", LLAVE, -1);
    expect(verificarFirma(token, LLAVE)).toBeNull();
  });

  it("rechaza token corrupto", () => {
    expect(verificarFirma("basura", LLAVE)).toBeNull();
    expect(verificarFirma("", LLAVE)).toBeNull();
  });

  it("integración con AlmacenAdjuntos", async () => {
    await setup();
    const contenido = Buffer.from("test");
    const adj = await almacen.guardar("t1", "i1", "m1", contenido, {
      nombre: "doc.pdf",
      tipoMime: "application/pdf",
    });
    expect(adj).not.toBeNull();

    const token = almacen.urlFirmada(adj!.ruta);
    const ruta = almacen.verificar(token);
    expect(ruta).toBe(adj!.ruta);

    const leido = await almacen.leer(ruta!);
    expect(leido).toEqual(contenido);
  });
});
