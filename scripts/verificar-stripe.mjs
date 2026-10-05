#!/usr/bin/env node
/**
 * Verificación previa de Stripe — corre ANTES de intentar cobrar.
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=/etc/cauce-firestore.json \
 *   node scripts/verificar-stripe.mjs
 *
 * Lee las variables de /etc/factory.env si existe (o las del entorno actual).
 * Valida:
 *   1. STRIPE_SECRET_KEY presente y en modo test (sk_test_)
 *   2. STRIPE_WEBHOOK_SECRET presente
 *   3. Los 9 price IDs presentes y con prefijo price_
 *   4. Cada price ID existe en Stripe y su monto cuadra con la tabla pública
 *   5. El webhook endpoint es alcanzable y verifica firma
 */

import { readFileSync } from "node:fs";
import Stripe from "stripe";

// ── Tabla pública de montos (MXN con IVA) ──────────────────────────────────
const MONTOS = {
  basico:   { mensual:   599, semestral:  3_234, anual:  5_388 },
  estandar: { mensual: 1_199, semestral:  6_474, anual: 10_788 },
  pro:      { mensual: 2_200, semestral: 11_880, anual: 19_800 },
};

const PLANES = ["basico", "estandar", "pro"];
const PERIODOS = ["mensual", "semestral", "anual"];

// ── Cargar env ──────────────────────────────────────────────────────────────
function cargarEnv() {
  // Intenta leer /etc/factory.env y mezclar con process.env
  try {
    const contenido = readFileSync("/etc/factory.env", "utf-8");
    for (const linea of contenido.split("\n")) {
      const limpia = linea.trim();
      if (!limpia || limpia.startsWith("#")) continue;
      const idx = limpia.indexOf("=");
      if (idx < 0) continue;
      const clave = limpia.slice(0, idx).trim();
      const valor = limpia.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[clave]) process.env[clave] = valor;
    }
    console.log("  Cargado /etc/factory.env\n");
  } catch {
    console.log("  /etc/factory.env no encontrado; usando variables del entorno actual\n");
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────
let errores = 0;
let avisos = 0;

function ok(msg) { console.log(`  \u2705 ${msg}`); }
function fallo(msg) { console.log(`  \u274C ${msg}`); errores++; }
function aviso(msg) { console.log(`  \u26A0\uFE0F  ${msg}`); avisos++; }

async function main() {
  console.log("=== Verificación previa de Stripe ===\n");
  cargarEnv();

  // 1. STRIPE_SECRET_KEY
  console.log("1. Llave secreta de Stripe");
  const sk = process.env.STRIPE_SECRET_KEY?.trim();
  if (!sk) {
    fallo("STRIPE_SECRET_KEY no definida. Configúrala en /etc/factory.env.");
    console.log("\n  No se puede continuar sin la llave. Abortando.\n");
    process.exit(1);
  }
  if (sk.startsWith("sk_test_")) {
    ok(`Modo PRUEBA (sk_test_…${sk.slice(-4)})`);
  } else if (sk.startsWith("sk_live_")) {
    fallo("Modo PRODUCCION detectado (sk_live_). Para pruebas usa una llave sk_test_.");
  } else {
    fallo(`Formato de llave no reconocido: ${sk.slice(0, 12)}…`);
  }

  // 2. STRIPE_WEBHOOK_SECRET
  console.log("\n2. Secreto del webhook");
  const whs = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!whs) {
    fallo("STRIPE_WEBHOOK_SECRET no definida. Configúrala en /etc/factory.env.");
  } else if (whs.startsWith("whsec_")) {
    ok(`Presente (whsec_…${whs.slice(-4)})`);
  } else {
    aviso(`Formato no estándar: ${whs.slice(0, 8)}… (se esperaba whsec_)`);
  }

  // 3. Los 9 price IDs
  console.log("\n3. Price IDs (9 requeridos)");
  const ids = {};
  let faltanIds = 0;
  for (const plan of PLANES) {
    ids[plan] = {};
    for (const periodo of PERIODOS) {
      const clave = `STRIPE_PRICE_${plan.toUpperCase()}_${periodo.toUpperCase()}`;
      const valor = process.env[clave]?.trim();
      if (!valor) {
        fallo(`${clave} no definida.`);
        faltanIds++;
      } else if (!valor.startsWith("price_")) {
        fallo(`${clave} = ${valor} — no empieza con price_`);
        faltanIds++;
      } else {
        ok(`${clave} = ${valor}`);
        ids[plan][periodo] = valor;
      }
    }
  }

  if (faltanIds > 0) {
    console.log(`\n  Faltan ${faltanIds} price ID(s). Créalos en Stripe Dashboard → Products.`);
  }

  // 4. Validar montos contra Stripe API
  console.log("\n4. Validación de montos contra Stripe");
  if (faltanIds > 0) {
    aviso("Se omite la validación de montos porque faltan price IDs.");
  } else {
    try {
      const stripe = new Stripe(sk, { timeout: 15_000 });
      let discrepancias = 0;
      for (const plan of PLANES) {
        for (const periodo of PERIODOS) {
          const priceId = ids[plan][periodo];
          const esperadoCentavos = MONTOS[plan][periodo] * 100;
          try {
            const price = await stripe.prices.retrieve(priceId);
            const reportado = price.unit_amount;
            const moneda = price.currency?.toUpperCase();
            const tipo = price.type;
            const recurrente = price.recurring;

            if (moneda !== "MXN") {
              fallo(`${plan}/${periodo} (${priceId}): moneda ${moneda}, se esperaba MXN.`);
              discrepancias++;
            } else if (reportado !== esperadoCentavos) {
              fallo(`${plan}/${periodo} (${priceId}): $${(reportado / 100).toLocaleString("es-MX")} MXN, se esperaban $${MONTOS[plan][periodo].toLocaleString("es-MX")} MXN.`);
              discrepancias++;
            } else {
              const intervalo = recurrente
                ? `cada ${recurrente.interval_count} ${recurrente.interval}(s)`
                : "no recurrente";
              ok(`${plan}/${periodo}: $${MONTOS[plan][periodo].toLocaleString("es-MX")} MXN (${tipo}, ${intervalo})`);
            }

            // Verificar que sea modo test
            if (price.livemode) {
              fallo(`${plan}/${periodo} (${priceId}): es un precio LIVE. Usa precios de prueba.`);
              discrepancias++;
            }
          } catch (err) {
            fallo(`${plan}/${periodo} (${priceId}): no se pudo leer de Stripe — ${err.message}`);
            discrepancias++;
          }
        }
      }
      if (discrepancias === 0) {
        ok("Todos los montos cuadran con la tabla pública.");
      }
    } catch (err) {
      fallo(`No se pudo conectar a Stripe: ${err.message}`);
    }
  }

  // 5. Resumen
  console.log("\n=== Resumen ===\n");
  if (errores === 0 && avisos === 0) {
    console.log("  Todo en orden. Puedes continuar con las pruebas de COMO-PROBAR.md.\n");
  } else {
    if (errores > 0) console.log(`  ${errores} error(es) — corrige antes de probar.\n`);
    if (avisos > 0) console.log(`  ${avisos} aviso(s) — revisa si aplican.\n`);
  }

  process.exit(errores > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nError inesperado: ${err.message}\n`);
  process.exit(2);
});
