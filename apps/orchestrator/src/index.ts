import { randomBytes } from "node:crypto";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { ColaEnvios } from "./cola.ts";
import { DockerManager } from "./docker/manager.ts";
import { GestorSesiones } from "./sesiones.ts";
import { RepositorioEnMemoria } from "./store.ts";

const puerto = Number(process.env.PORT ?? 3001);

// La key vive en el entorno del servicio (systemd), nunca en el repo.
// Sin env se genera una efímera y se imprime, para desarrollo local.
const apiKey = process.env.CAUCE_API_KEY ?? randomBytes(24).toString("hex");
if (!process.env.CAUCE_API_KEY) {
  console.log(`API key efímera del tenant demo: ${apiKey}`);
}

const repo = new RepositorioEnMemoria({
  tenants: [
    {
      id: "demo",
      nombre: "Tenant demo",
      plan: "basico",
      estado: "activo",
      apiKeyHash: hashApiKey(apiKey),
      creadoEn: new Date().toISOString(),
    },
  ],
});

const docker = new DockerManager();
const cola = new ColaEnvios({
  dir: process.env.CAUCE_DATA_DIR
    ? `${process.env.CAUCE_DATA_DIR}/cola`
    : new URL("../data/cola", import.meta.url).pathname,
  repo,
});
const gestor = new GestorSesiones({
  docker,
  repo,
  cola,
  // Cómo alcanzan los contenedores al orquestador (webhooks). En prod,
  // detrás de Caddy, será la URL interna del host.
  urlPublica:
    process.env.CAUCE_URL_WEBHOOKS ?? `http://host.docker.internal:${puerto}`,
});

const corsOrigenes = (
  process.env.CAUCE_CORS_ORIGENES ?? "http://localhost:5173"
).split(",");

if (await docker.disponible()) {
  const n = await gestor.rehidratar();
  console.log(`sesiones rehidratadas desde Docker: ${n}`);
} else {
  console.warn("Docker no disponible; se arranca sin sesiones");
}

crearApp(repo, gestor, { corsOrigenes, cola }).listen(puerto, () => {
  console.log(`orquestador escuchando en :${puerto}`);
});
