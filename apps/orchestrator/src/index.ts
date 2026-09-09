import { randomBytes } from "node:crypto";
import type { Tenant } from "@cauce/core";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { ColaEnvios } from "./cola.ts";
import { DockerManager } from "./docker/manager.ts";
import { GestorSesiones } from "./sesiones.ts";
import { barrerSinConfirmar } from "./confirmaciones.ts";
import { RepositorioEnMemoria, type Repositorio } from "./store.ts";
import { RepositorioFirestore } from "./store-firestore.ts";
import { ConectorMonday } from "./monday/conector.ts";
import { ConectorBitrix } from "./bitrix/conector.ts";
import { MotorEntrada } from "./entrada/motor.ts";
import { Cripto } from "./cripto.ts";
import { crearVerificadorToken } from "./firebase.ts";
import { Provisioning } from "./provisioning.ts";

const puerto = Number(process.env.PORT ?? 3001);

// La key vive en el entorno del servicio (systemd), nunca en el repo.
// Sin env se genera una efímera y se imprime, para desarrollo local.
const apiKey = process.env.CAUCE_API_KEY ?? randomBytes(24).toString("hex");
if (!process.env.CAUCE_API_KEY) {
  console.log(`API key efímera del tenant demo: ${apiKey}`);
}

// Firestore si hay credenciales (o el emulador); en memoria en su
// ausencia, para desarrollo local sin GCP y para las pruebas.
const usaFirestore = Boolean(
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIRESTORE_PROJECT_ID ||
    process.env.FIRESTORE_EMULATOR_HOST,
);

const tenantDemo: Tenant = {
  id: "demo",
  nombre: "Tenant demo",
  plan: "base",
  estado: "activo",
  apiKeyHash: hashApiKey(apiKey),
  creadoEn: new Date().toISOString(),
};

let repo: Repositorio;
if (usaFirestore) {
  repo = new RepositorioFirestore();
  // Alta idempotente del tenant demo: garantiza que la key del entorno
  // funcione. Reescribe solo el doc del tenant, no sus instancias ni
  // mensajes, así que no pierde historial entre reinicios.
  await repo.saveTenant(tenantDemo);
  console.log("repositorio: Firestore");
} else {
  repo = new RepositorioEnMemoria({ tenants: [tenantDemo] });
  console.log("repositorio: en memoria (sin persistencia)");
}

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
  process.env.CAUCE_CORS_ORIGENES ??
  "http://localhost:5173,https://cauce-consola.web.app"
).split(",");

if (await docker.disponible()) {
  const n = await gestor.rehidratar();
  console.log(`sesiones rehidratadas desde Docker: ${n}`);
} else {
  console.warn("Docker no disponible; se arranca sin sesiones");
}

const cripto = new Cripto();
const monday = new ConectorMonday({ repo, cola, cripto });
const bitrix = new ConectorBitrix({ repo, cola, cripto });
const motorEntrada = new MotorEntrada({
  repo,
  monday,
  bitrix,
  // Carril inmediato: las respuestas automáticas no pasan por la cola.
  enviarInmediato: (t, i, tel, cuerpo) =>
    gestor.enviarDirecto(t, i, tel, cuerpo),
});

const verificarToken = crearVerificadorToken();
const provisioning = new Provisioning(repo);
const adminKey = process.env.CAUCE_ADMIN_KEY;
if (!adminKey) {
  console.warn("CAUCE_ADMIN_KEY sin definir: el endpoint admin de plan queda deshabilitado");
}

// Barrido de pruebas vencidas: desconecta (sin destruir) las sesiones de
// tenants cuya prueba caducó. Cada 5 min; idempotente.
const barrer = async () => {
  try {
    const n = await gestor.vencerPruebas();
    if (n > 0) console.log(`pruebas vencidas: ${n} sesiones desconectadas`);
  } catch (err: any) {
    console.warn(`barrido de pruebas falló: ${err?.message}`);
  }
};
void barrer();
setInterval(barrer, 5 * 60_000);

// Barrido de entregas sin confirmar: los `enviado` que Evolution nunca
// confirmó pasan a `no_confirmado` (detecta el bug PENDING). Cada minuto.
const barrerConfirmaciones = async () => {
  try {
    const n = await barrerSinConfirmar(repo);
    if (n > 0) console.log(`envíos sin confirmar marcados: ${n}`);
  } catch (err: any) {
    console.warn(`barrido de confirmaciones falló: ${err?.message}`);
  }
};
void barrerConfirmaciones();
setInterval(barrerConfirmaciones, 60_000);

crearApp(repo, gestor, {
  corsOrigenes,
  cola,
  monday,
  bitrix,
  motorEntrada,
  verificarToken,
  provisioning,
  version: process.env.CAUCE_VERSION ?? "dev",
  ...(adminKey ? { adminKey } : {}),
}).listen(puerto, () => {
  console.log(`orquestador escuchando en :${puerto} (versión ${process.env.CAUCE_VERSION ?? "dev"})`);
});
