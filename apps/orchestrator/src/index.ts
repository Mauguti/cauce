import { crearApp } from "./app.ts";
import { RepositorioEnMemoria } from "./store.ts";

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
  instances: [
    {
      id: "inst-1",
      tenantId: "demo",
      transportType: "mock",
      contenedorId: null,
      numero: "+525512345678",
      estado: "pending",
      ultimoHeartbeat: null,
    },
  ],
});

const puerto = Number(process.env.PORT ?? 3001);
crearApp(repo).listen(puerto, () => {
  console.log(`orquestador escuchando en :${puerto}`);
});
