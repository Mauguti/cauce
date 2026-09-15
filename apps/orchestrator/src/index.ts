import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Tenant } from "@cauce/core";
import { crearApp } from "./app.ts";
import { hashApiKey } from "./auth.ts";
import { ColaEnvios } from "./cola.ts";
import { DockerManager } from "./docker/manager.ts";
import { GestorSesiones } from "./sesiones.ts";
import { barrerSinConfirmar } from "./confirmaciones.ts";
import { aplicarPlanesVencidos } from "./planes.ts";
import { RepositorioEnMemoria, type Repositorio } from "./store.ts";
import { RepositorioFirestore } from "./store-firestore.ts";
import { ConectorMonday } from "./monday/conector.ts";
import { ConectorBitrix } from "./bitrix/conector.ts";
import { MotorEntrada } from "./entrada/motor.ts";
import { Agente } from "./agentes/agente.ts";
import { ProveedorAnthropic } from "./agentes/proveedor.ts";
import { Cripto } from "./cripto.ts";
import { crearVerificadorToken } from "./firebase.ts";
import { Provisioning } from "./provisioning.ts";
import { Cobrador } from "./cobro/cobrador.ts";
import { CargadorPrecios } from "./cobro/precios.ts";
import { ClienteStripeReal } from "./cobro/stripe.ts";
import { GoogleReal } from "./google/calendario.ts";
import { Citas } from "./agentes/citas.ts";
import { ConectorOpenlines } from "./bitrix/openlines/conector.ts";

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
  plan: "estandar",
  estado: "activo",
  apiKeyHash: hashApiKey(apiKey),
  creadoEn: new Date().toISOString(),
};

let repo: Repositorio;
if (usaFirestore) {
  const repoFs = new RepositorioFirestore();
  repo = repoFs;
  // Alta idempotente del tenant demo: garantiza que la key del entorno
  // funcione. Reescribe solo el doc del tenant, no sus instancias ni
  // mensajes, así que no pierde historial entre reinicios.
  await repo.saveTenant(tenantDemo);
  // La base se imprime para poder verificar en el log que un orquestador
  // apunta a su propia base (CAUCE_FIRESTORE_DB) y no a la de otro.
  console.log(`repositorio: Firestore (base: ${repoFs.databaseId})`);
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
// Canal abierto de Bitrix24 (Contact Center). Necesita la URL pública del
// orquestador para el handler que el portal llama; sin ella, no se habilita.
const urlPublica = process.env.CAUCE_URL_PUBLICA?.trim();
const openlines = urlPublica
  ? new ConectorOpenlines({
      repo,
      cola,
      cripto,
      urlPublica,
      enviarInmediato: (t, i, tel, cuerpo, origen) => gestor.enviarDirecto(t, i, tel, cuerpo, origen),
      sesionViva: (i) => gestor.obtener(i) !== null,
    })
  : undefined;
if (!openlines) {
  console.warn("CAUCE_URL_PUBLICA sin definir: el canal abierto de Bitrix24 queda deshabilitado");
}

// Google Calendar por tenant (Susana). Credenciales de la app OAuth en
// /etc/factory.env; el redirect es fijo: <CAUCE_URL_PUBLICA>/google/callback.
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const google = googleClientId && googleClientSecret && urlPublica
  ? new GoogleReal({ clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: `${urlPublica.replace(/\/+$/, "")}/google/callback`, repo, cripto })
  : undefined;
if (!google) console.warn("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (o CAUCE_URL_PUBLICA) sin definir: Google Calendar y Susana quedan deshabilitados");
const citas = google ? new Citas({ repo, calendario: google }) : undefined;

// Agente conversacional: razona en el orquestador con el proveedor del
// tenant. Hoy un proveedor (Anthropic) con la llave de ANTHROPIC_API_KEY.
const agente = process.env.ANTHROPIC_API_KEY?.trim()
  ? new Agente({ repo, proveedores: { anthropic: new ProveedorAnthropic() }, bitrix, monday, cripto, ...(openlines ? { openlines } : {}), ...(citas ? { citas } : {}) })
  : undefined;
if (!agente) console.warn("ANTHROPIC_API_KEY sin definir: los agentes quedan deshabilitados");

const motorEntrada = new MotorEntrada({
  ...(agente ? { agente } : {}),
  ...(process.env.CAUCE_AVISOS_WHATSAPP?.trim() ? { avisosWhatsApp: process.env.CAUCE_AVISOS_WHATSAPP.trim() } : {}),
  repo,
  monday,
  bitrix,
  ...(openlines ? { openlines } : {}),
  // Carril inmediato: las respuestas automáticas no pasan por la cola.
  enviarInmediato: (t, i, tel, cuerpo, origen) => gestor.enviarDirecto(t, i, tel, cuerpo, origen),
});

// Cobro con tarjeta (docs/stripe.md). Las llaves viven en /etc/factory.env;
// el prefijo sk_test_/sk_live_ decide el modo y /health lo expone. Los
// precios se leen de la plataforma (CAUCE_PRECIOS_URL): sin foto, no se cobra.
const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
const stripe = stripeKey && stripeWebhookSecret ? new ClienteStripeReal({ secretKey: stripeKey, webhookSecret: stripeWebhookSecret }) : null;
if (!stripe) console.warn("STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET sin definir: el cobro con tarjeta queda deshabilitado (solo transferencia por admin)");
const preciosUrl = process.env.CAUCE_PRECIOS_URL?.trim();
if (!preciosUrl) console.warn("CAUCE_PRECIOS_URL sin definir: no se cotiza ni se cobra ningún corte");
const avisosWhatsApp = process.env.CAUCE_AVISOS_WHATSAPP?.trim();
const cobrador = new Cobrador({
  repo,
  stripe,
  precios: new CargadorPrecios({ url: preciosUrl }),
  // Aviso a Mau desde la primera línea viva del tenant afectado (mismo canal que el cortacircuitos); sin línea viva, solo bitácora.
  ...(avisosWhatsApp
    ? {
        avisar: async (tenantId: string, texto: string) => {
          const viva = (await repo.listInstances(tenantId)).find((i) => gestor.obtener(i.id) !== null);
          if (!viva) throw new Error(`tenant ${tenantId} sin línea viva para avisar`);
          await gestor.enviarDirecto(tenantId, viva.id, avisosWhatsApp, texto, "sistema");
        },
      }
    : {}),
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

// Cambios de plan a la baja pendientes: aplican al cierre del ciclo pagado.
// Cada 5 min; idempotente.
const aplicarPlanesPendientes = async () => {
  try {
    const n = await aplicarPlanesVencidos(repo);
    if (n > 0) console.log(`planes pendientes aplicados: ${n}`);
  } catch (err: any) {
    console.warn(`barrido de planes pendientes falló: ${err?.message}`);
  }
};
void aplicarPlanesPendientes();
setInterval(aplicarPlanesPendientes, 5 * 60_000);

// Cobro de cortes con tarjeta: cada hora (el calendario 0/+3/+7 es en días;
// correr seguido no duplica: clave de idempotencia por tenant:corte).
const cobrarCortes = async () => {
  try {
    const n = await cobrador.cobrarCortes();
    if (n > 0) console.log(`cobros intentados: ${n}`);
  } catch (err: any) {
    console.warn(`cobro de cortes falló: ${err?.message}`);
  }
};
setTimeout(() => { void cobrarCortes(); }, 60_000);
setInterval(cobrarCortes, 60 * 60_000);

/**
 * Versión desplegada para /health y el log de arranque. Si CAUCE_VERSION
 * viene vacía, se lee el HEAD de git del directorio del código: así
 * /health dice la verdad sin pasos manuales en cada despliegue. Sin
 * repositorio, "dev". Con cambios sin commitear, el hash lleva "+".
 */
function versionDesplegada(): string {
  const env = process.env.CAUCE_VERSION?.trim();
  if (env) return env;
  try {
    const raiz = new URL("../../..", import.meta.url).pathname;
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: raiz, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    const sucio = execFileSync("git", ["status", "--porcelain"], { cwd: raiz, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().length > 0;
    return hash ? `${hash}${sucio ? "+" : ""}` : "dev";
  } catch {
    return "dev";
  }
}
const version = versionDesplegada();

crearApp(repo, gestor, {
  corsOrigenes,
  ...(openlines ? { openlines } : {}),
  cola,
  monday,
  bitrix,
  motorEntrada,
  verificarToken,
  provisioning,
  version,
  ...(adminKey ? { adminKey } : {}),
  cripto,
  cobrador,
  ...(google ? { google } : {}),
  ...(process.env.CAUCE_PLATAFORMA_URL?.trim() ? { plataformaUrl: process.env.CAUCE_PLATAFORMA_URL.trim() } : {}),
  // Consumo en pesos: tipo de cambio con colchón. Se ajusta en /etc/factory.env sin tocar código.
  tipoCambio: {
    // Default revisado 15-sep-2026 (dólar a 17.13); se revisa cada mes, el peso se mueve.
    usdMxn: Number(process.env.CAUCE_USD_MXN) > 0 ? Number(process.env.CAUCE_USD_MXN) : 17.15,
    colchon: Number(process.env.CAUCE_USD_MXN_COLCHON) > 0 ? Number(process.env.CAUCE_USD_MXN_COLCHON) : 1.1,
  },
}).listen(puerto, () => {
  console.log(`orquestador escuchando en :${puerto} (versión ${version})`);
  // Ya con el puerto abierto: ¿los contenedores rehidratados alcanzan al
  // orquestador? Antes de este punto la sonda daría un fallo falso.
  gestor.comprobarAlcanceSesiones().catch((err: any) =>
    console.warn(`sonda de alcance de webhooks falló: ${err?.message}`),
  );
});
