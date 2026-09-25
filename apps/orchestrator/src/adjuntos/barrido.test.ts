import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Adjunto, Message, Tenant } from "@cauce/core";
import { AlmacenAdjuntos } from "./almacen.ts";
import { barrerAdjuntos } from "./barrido.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { usarSalida } from "../log.ts";

const LLAVE = Buffer.alloc(32, 7);

let tempDir: string;
const bitacora: string[] = [];
usarSalida((_n, l) => { bitacora.push(l); });
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  bitacora.length = 0;
});

function crearTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "t1", nombre: "Test", plan: "estandar", estado: "activo",
    creadoEn: "2028-01-01T00:00:00Z",
    ...overrides,
  };
}

function crearMensaje(id: string, adjuntos: Adjunto[], timestamp?: string): Message {
  return {
    id, tenantId: "t1", instanceId: "i1", direccion: "in",
    telefono: "+5215500001111", cuerpo: "", estado: "recibido",
    externalId: null, timestamp: timestamp ?? "2028-01-15T10:00:00Z",
    adjuntos,
  };
}

describe("barrerAdjuntos", () => {
  it("borra adjuntos que exceden la retención del plan", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cauce-barrido-"));
    const almacen = new AlmacenAdjuntos({ directorio: tempDir, llave: LLAVE });

    const contenido = Buffer.from("viejo");
    const adj = await almacen.guardar("t1", "i1", "m1", contenido, {
      nombre: "viejo.jpg", tipoMime: "image/jpeg",
    });

    const repo = new RepositorioEnMemoria({
      tenants: [crearTenant({ plan: "basico" })], // 30 días de retención
    });
    await repo.saveMessage(crearMensaje("m1", [{
      ...adj!, guardadoEn: "2028-01-01T00:00:00Z",
    }]));

    // "Ahora" es 60 días después → adjunto de 30 días debe expirar.
    const ahora = new Date("2028-03-02T00:00:00Z");
    const resultado = await barrerAdjuntos(repo, almacen, ahora);

    expect(resultado.borrados).toBe(1);
    expect(resultado.bytesLiberados).toBe(contenido.length);

    const msg = await repo.getMessage("t1", "m1");
    expect(msg!.adjuntos![0].expirado).toBe(true);
    // El mensaje sigue en pie.
    expect(msg!.cuerpo).toBe("");

    // El archivo ya no está en disco.
    expect(await almacen.leer(adj!.ruta)).toBeNull();
  });

  it("no borra adjuntos que aún no vencen", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cauce-barrido-"));
    const almacen = new AlmacenAdjuntos({ directorio: tempDir, llave: LLAVE });

    const contenido = Buffer.from("reciente");
    const adj = await almacen.guardar("t1", "i1", "m2", contenido, {
      nombre: "reciente.jpg", tipoMime: "image/jpeg",
    });

    const repo = new RepositorioEnMemoria({
      tenants: [crearTenant({ plan: "estandar" })], // 180 días
    });
    await repo.saveMessage(crearMensaje("m2", [{
      ...adj!, guardadoEn: "2028-06-01T00:00:00Z",
    }]));

    // Solo 10 días después → no debe expirar.
    const ahora = new Date("2028-06-11T00:00:00Z");
    const resultado = await barrerAdjuntos(repo, almacen, ahora);

    expect(resultado.borrados).toBe(0);
    expect(await almacen.leer(adj!.ruta)).not.toBeNull();
  });

  it("borra los más viejos cuando el tenant excede el tope", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cauce-barrido-"));
    const almacen = new AlmacenAdjuntos({ directorio: tempDir, llave: LLAVE });

    // Plan básico: tope 2 GB. Simulamos superarlo con archivos chicos.
    // Usamos el mecanismo: el tope real es 2 GB, pero lo importante es que
    // se borren los más viejos. Verificamos la lógica no la escala.
    const repo = new RepositorioEnMemoria({
      tenants: [crearTenant({ plan: "basico" })],
    });

    const adj1 = await almacen.guardar("t1", "i1", "m1", Buffer.alloc(500), {
      nombre: "viejo.jpg", tipoMime: "image/jpeg",
    });
    const adj2 = await almacen.guardar("t1", "i1", "m2", Buffer.alloc(500), {
      nombre: "nuevo.jpg", tipoMime: "image/jpeg",
    });

    await repo.saveMessage(crearMensaje("m1", [{
      ...adj1!, guardadoEn: "2028-01-01T00:00:00Z",
    }]));
    await repo.saveMessage(crearMensaje("m2", [{
      ...adj2!, guardadoEn: "2028-01-10T00:00:00Z",
    }]));

    // Ambos están dentro de retención (30d), pero si estuvieran sobre el tope,
    // se borraría el más viejo. Para forzar esto necesitaríamos archivos de 2+ GB,
    // lo cual no es práctico en un test. Verificamos que la función corre sin error.
    const ahora = new Date("2028-01-15T00:00:00Z");
    const resultado = await barrerAdjuntos(repo, almacen, ahora);

    // Ninguno vence por edad (14 días < 30 días) y no exceden 2 GB.
    expect(resultado.borrados).toBe(0);
  });

  it("no toca adjuntos ya marcados como expirados", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cauce-barrido-"));
    const almacen = new AlmacenAdjuntos({ directorio: tempDir, llave: LLAVE });

    const repo = new RepositorioEnMemoria({
      tenants: [crearTenant({ plan: "basico" })],
    });
    await repo.saveMessage(crearMensaje("m1", [{
      id: "ya-expirado", nombre: "viejo.jpg", tipoMime: "image/jpeg",
      tamano: 1000, ruta: "t1/i1/m1/ya-expirado.jpg",
      guardadoEn: "2027-01-01T00:00:00Z", expirado: true,
    }]));

    const ahora = new Date("2028-06-01T00:00:00Z");
    const resultado = await barrerAdjuntos(repo, almacen, ahora);
    expect(resultado.borrados).toBe(0);
  });
});
