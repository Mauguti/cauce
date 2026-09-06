/**
 * Ciclo completo end-to-end contra Docker real, vía los endpoints HTTP
 * del orquestador (levantado en este mismo proceso):
 *
 *   crear sesión → mostrar QR en terminal → esperar conexión →
 *   enviar un mensaje → imprimir lo que llegue por webhook
 *
 * Uso:
 *   npx tsx scripts/prueba-ciclo.ts +5215512345678 [--limpiar]
 *
 * El número es el destino del mensaje de prueba (formato internacional).
 * Con --limpiar, al final se destruye contenedor y volumen; sin él, la
 * sesión queda viva para no reescanear la próxima vez.
 */
import qrcode from "qrcode-terminal";
import { crearApp } from "../apps/orchestrator/src/app.ts";
import { hashApiKey } from "../apps/orchestrator/src/auth.ts";
import { DockerManager } from "../apps/orchestrator/src/docker/manager.ts";
import { GestorSesiones } from "../apps/orchestrator/src/sesiones.ts";
import { RepositorioEnMemoria } from "../apps/orchestrator/src/store.ts";

const destino = process.argv[2];
const limpiar = process.argv.includes("--limpiar");
if (!destino || !/^\+\d{10,15}$/.test(destino.replace(/\s/g, ""))) {
  console.error(
    "Uso: npx tsx scripts/prueba-ciclo.ts +5215512345678 [--limpiar]",
  );
  process.exit(1);
}

const PUERTO = 3001;
const TENANT = "demo";
const BASE = `http://127.0.0.1:${PUERTO}/api/tenants/${TENANT}`;

const API_KEY = "key-local-prueba-ciclo";
const repo = new RepositorioEnMemoria({
  tenants: [
    {
      id: TENANT,
      nombre: "Tenant demo",
      plan: "basico",
      estado: "activo",
      apiKeyHash: hashApiKey(API_KEY),
      creadoEn: new Date().toISOString(),
    },
  ],
});
const docker = new DockerManager();
const gestor = new GestorSesiones({
  docker,
  repo,
  urlPublica: `http://host.docker.internal:${PUERTO}`,
});

function api(ruta: string, init: RequestInit = {}) {
  return fetch(`${BASE}${ruta}`, {
    ...init,
    headers: { ...(init.headers ?? {}), "x-api-key": API_KEY },
  });
}

function paso(msg: string) {
  console.log(`\n== ${msg}`);
}

async function esperar<T>(
  descripcion: string,
  timeoutMs: number,
  intervaloMs: number,
  intento: () => Promise<T | null>,
): Promise<T> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const resultado = await intento();
    if (resultado !== null) return resultado;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  throw new Error(`Timeout esperando: ${descripcion}`);
}

if (!(await docker.disponible())) {
  console.error("Docker no está disponible; arranca el daemon primero.");
  process.exit(1);
}

const servidor = crearApp(repo, gestor).listen(PUERTO);
let instanceId: string | null = null;

try {
  paso("Creando sesión (contenedor + BD + instancia Evolution)…");
  const creacion = await api("/instances", { method: "POST" });
  if (creacion.status !== 201) {
    throw new Error(`POST /instances → ${creacion.status}: ${await creacion.text()}`);
  }
  const instancia = await creacion.json();
  instanceId = instancia.id as string;
  console.log(`   instancia ${instanceId} · contenedor ${instancia.contenedorId.slice(0, 12)}`);

  paso("Esperando QR…");
  const qr = await esperar("QR", 90_000, 2000, async () => {
    const res = await api(`/instances/${instanceId}/qr`);
    if (res.status !== 200) return null;
    return (await res.json()) as { codigo: string };
  });
  qrcode.generate(qr.codigo, { small: true });
  console.log("Escanea el QR con WhatsApp (Dispositivos vinculados).");

  paso("Esperando conexión (hasta 3 minutos)…");
  let ultimoEstado = "";
  await esperar("conexión", 180_000, 2500, async () => {
    const res = await api(`/instances/${instanceId}`);
    const inst = await res.json();
    if (inst.estado !== ultimoEstado) {
      ultimoEstado = inst.estado;
      console.log(`   estado: ${inst.estado}`);
    }
    return inst.estado === "connected" ? inst : null;
  });
  console.log("   ¡Conectada!");

  paso(`Enviando mensaje de prueba a ${destino}…`);
  const envio = await api(`/instances/${instanceId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      telefono: destino,
      cuerpo: `Prueba de ciclo Cauce · ${new Date().toLocaleTimeString("es-MX")}`,
    }),
  });
  if (envio.status !== 201) {
    throw new Error(`send → ${envio.status}: ${await envio.text()}`);
  }
  const enviado = await envio.json();
  console.log(`   enviado, externalId=${enviado.externalId}`);

  paso("Esperando respuesta entrante (60s; responde desde el otro teléfono)…");
  try {
    const entrantes = await esperar("mensaje entrante", 60_000, 1500, async () => {
      const mensajes = await repo.listMessages(TENANT, instanceId!);
      const dentro = mensajes.filter((m) => m.direccion === "in");
      return dentro.length > 0 ? dentro : null;
    });
    for (const m of entrantes) {
      console.log(`   ← [${m.timestamp}] ${m.telefono}: ${m.cuerpo}`);
    }
  } catch {
    console.log("   (no llegó respuesta en 60s; el webhook queda escuchando)");
  }

  console.log("\nCiclo completo ✔");
} finally {
  if (limpiar && instanceId) {
    paso("Limpiando contenedor y volumen…");
    await api(`/instances/${instanceId}`, { method: "DELETE" });
  } else if (instanceId) {
    console.log(
      `\nSesión viva: contenedor cauce-${TENANT}-${instanceId} sigue corriendo (usa --limpiar para destruirla).`,
    );
  }
  servidor.close();
}
