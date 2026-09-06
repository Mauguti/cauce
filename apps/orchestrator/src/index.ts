import { crearApp } from "./app.ts";
import { DockerManager } from "./docker/manager.ts";
import { GestorSesiones } from "./sesiones.ts";
import { RepositorioEnMemoria } from "./store.ts";

const puerto = Number(process.env.PORT ?? 3001);

const repo = new RepositorioEnMemoria({
  tenants: [
    {
      id: "demo",
      nombre: "Tenant demo",
      plan: "basico",
      estado: "activo",
      creadoEn: new Date().toISOString(),
    },
  ],
});

const docker = new DockerManager();
const gestor = new GestorSesiones({
  docker,
  repo,
  // Cómo alcanzan los contenedores al orquestador (webhooks). En prod,
  // detrás de Caddy, será la URL interna del host.
  urlPublica:
    process.env.CAUCE_URL_WEBHOOKS ?? `http://host.docker.internal:${puerto}`,
});

crearApp(repo, gestor).listen(puerto, () => {
  console.log(`orquestador escuchando en :${puerto}`);
});
