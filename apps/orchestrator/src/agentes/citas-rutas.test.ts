import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { crearApp } from "../app.ts";
import { hashApiKey } from "../auth.ts";
import { RepositorioEnMemoria } from "../store.ts";
import { Cripto } from "../cripto.ts";
import { usarSalida } from "../log.ts";
import { GoogleReal, SCOPE_CALENDAR } from "../google/calendario.ts";

const KEY = "key-tenant-a-0000000000000000";
const bitacora: string[] = [];
usarSalida((_n, l) => { bitacora.push(l); });
afterEach(() => { bitacora.length = 0; });

function levantar(opciones: { fetchImpl?: typeof fetch } = {}) {
  const repo = new RepositorioEnMemoria({
    tenants: [{ id: "a", nombre: "Taller", plan: "pro", estado: "activo", apiKeyHash: hashApiKey(KEY), creadoEn: "2026-09-05T00:00:00Z", agente: { activo: true, nombre: "Susana", rol: "citas", proveedor: "anthropic", modelo: "claude-opus-5" } }],
  });
  const cripto = new Cripto(Buffer.alloc(32, 7));
  const google = new GoogleReal({ clientId: "id", clientSecret: "secreto", redirectUri: "https://api.test/google/callback", repo, cripto, ...(opciones.fetchImpl ? { fetchImpl: opciones.fetchImpl } : {}) });
  const server = crearApp(repo, undefined, { adminKey: "admin", google, plataformaUrl: "https://factory.test" }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, repo, google, cerrar: () => server.close() };
}
const conKey = { headers: { "x-api-key": KEY, "content-type": "application/json" } };

describe("rutas de Susana", () => {
  it("directorio: alta, lista, modo cliente y baja, con bitácora de nombre y número", async () => {
    const { base, cerrar } = levantar();
    try {
      const malo = await fetch(`${base}/api/tenants/a/directorio`, { ...conKey, method: "PUT", body: JSON.stringify({ telefono: "123", nombre: "x", rol: "dueno" }) });
      expect(malo.status).toBe(400);
      const alta = await fetch(`${base}/api/tenants/a/directorio`, { ...conKey, method: "PUT", body: JSON.stringify({ telefono: "+52 1 442 000 0100", nombre: "Raúl", rol: "dueno" }) });
      expect(alta.status).toBe(201);
      expect(await alta.json()).toMatchObject({ telefono: "5214420000100", nombre: "Raúl", rol: "dueno", calendarioId: null, enModoCliente: false });
      const prof = await fetch(`${base}/api/tenants/a/directorio`, { ...conKey, method: "PUT", body: JSON.stringify({ telefono: "5214420000101", nombre: "Luis", rol: "profesional", calendarioId: "luis@taller.com" }) });
      expect(prof.status).toBe(201);
      const lista = await fetch(`${base}/api/tenants/a/directorio`, conKey).then((r) => r.json());
      expect(lista.map((p: any) => p.nombre)).toEqual(["Luis", "Raúl"]);
      const modo = await fetch(`${base}/api/tenants/a/directorio/5214420000100/modo-cliente`, { ...conKey, method: "POST", body: JSON.stringify({ activar: true }) });
      expect((await modo.json()).enModoCliente).toBe(true);
      expect(bitacora.some((l) => l.includes("directorio.modo_cliente") && l.includes("quien=Raúl") && l.includes("telefono=+521••••0100"))).toBe(true);
      expect((await fetch(`${base}/api/tenants/a/directorio/5214420000101`, { ...conKey, method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${base}/api/tenants/a/directorio/5214420000101`, { ...conKey, method: "DELETE" })).status).toBe(404);
      expect((await fetch(`${base}/api/tenants/a/directorio`)).status).toBe(401);
    } finally {
      cerrar();
    }
  });

  it("agenda: defaults y ajuste validado", async () => {
    const { base, cerrar } = levantar();
    try {
      const d = await fetch(`${base}/api/tenants/a/agenda`, conKey).then((r) => r.json());
      expect(d).toMatchObject({ calendarioId: "primary", duracionMin: 60, horario: { dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "18:00" }, configurada: false });
      const mal = await fetch(`${base}/api/tenants/a/agenda`, { ...conKey, method: "PUT", body: JSON.stringify({ horario: { desde: "18:00", hasta: "09:00" } }) });
      expect(mal.status).toBe(400);
      const ok = await fetch(`${base}/api/tenants/a/agenda`, { ...conKey, method: "PUT", body: JSON.stringify({ duracionMin: 30, horario: { dias: [1, 2, 3, 4, 5, 6], desde: "10:00", hasta: "19:00" }, ventanaDias: 21 }) });
      expect(await ok.json()).toMatchObject({ duracionMin: 30, horario: { dias: [1, 2, 3, 4, 5, 6], desde: "10:00", hasta: "19:00" }, ventanaDias: 21, configurada: true });
    } finally {
      cerrar();
    }
  });

  it("google: conectar devuelve la URL de Google con scope mínimo; el callback guarda el refresh token cifrado y redirige a Integraciones", async () => {
    const llamadas: string[] = [];
    const fetchFalso: typeof fetch = async (url, init) => {
      llamadas.push(String(url));
      if (String(url).includes("oauth2.googleapis.com/token")) {
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        return new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref-secreto", expires_in: 3600, scope: SCOPE_CALENDAR }), { status: 200 });
      }
      if (String(url).includes("userinfo")) return new Response(JSON.stringify({ email: "taller@gmail.com" }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const { base, repo, cerrar } = levantar({ fetchImpl: fetchFalso });
    try {
      const estado0 = await fetch(`${base}/api/tenants/a/google`, conKey).then((r) => r.json());
      expect(estado0).toEqual({ disponible: true, conectado: false, email: null, conectadoEn: null });
      const { url } = await fetch(`${base}/api/tenants/a/google/conectar`, { ...conKey, method: "POST" }).then((r) => r.json());
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(u.searchParams.get("scope")).toContain("calendar.events");
      expect(u.searchParams.get("scope")).not.toMatch(/auth\/calendar(\s|$)/);
      expect(u.searchParams.get("access_type")).toBe("offline");
      const state = u.searchParams.get("state")!;

      const cb = await fetch(`${base}/google/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
      expect(cb.status).toBe(302);
      expect(cb.headers.get("location")).toBe("https://factory.test/dashboard/integrations?google=ok&detalle=taller%40gmail.com");
      const doc = await repo.getConectorGoogle("a");
      expect(doc?.email).toBe("taller@gmail.com");
      expect(doc?.refreshTokenCifrado).not.toContain("ref-secreto");
      expect(doc?.refreshTokenCifrado.startsWith("gcm1:")).toBe(true);
      const estado1 = await fetch(`${base}/api/tenants/a/google`, conKey).then((r) => r.json());
      expect(estado1).toMatchObject({ conectado: true, email: "taller@gmail.com" });

      const malo = await fetch(`${base}/google/callback?code=abc&state=basura`, { redirect: "manual" });
      expect(malo.headers.get("location")).toContain("google=error");
      const denegado = await fetch(`${base}/google/callback?error=access_denied`, { redirect: "manual" });
      expect(denegado.headers.get("location")).toContain("google=denegado");
      expect((await fetch(`${base}/api/tenants/a/google`, { ...conKey, method: "DELETE" })).status).toBe(204);
      expect(await repo.getConectorGoogle("a")).toBeNull();
      expect(llamadas.some((l) => l.includes("/revoke"))).toBe(true);
    } finally {
      cerrar();
    }
  });

  it("GET /agentes expone el rol y las herramientas de citas; el admin puede fijar rol=citas", async () => {
    const { base, cerrar } = levantar();
    try {
      const [a] = await fetch(`${base}/api/tenants/a/agentes`, conKey).then((r) => r.json());
      expect(a).toMatchObject({ nombre: "Susana", rol: "citas", google: false, herramientas: ["pasar_a_humano", "consultar_disponibilidad", "consultar_citas", "proponer_cambio", "confirmar_cambio"] });
      const r = await fetch(`${base}/api/admin/tenants/a/agente`, { method: "POST", headers: { "x-admin-key": "admin", "content-type": "application/json" }, body: JSON.stringify({ nombre: "Santiago", rol: "ventas" }) });
      expect((await r.json()).agente.rol).toBe("ventas");
    } finally {
      cerrar();
    }
  });
});
