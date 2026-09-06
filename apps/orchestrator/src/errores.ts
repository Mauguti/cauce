import type { FalloEnvio } from "@cauce/core";

export interface DiagnosticoFallo {
  codigo: FalloEnvio;
  /** Mensaje para el operador: qué pasó y qué hacer. */
  mensaje: string;
  /** ¿Reintentar el mismo mensaje puede funcionar tras corregir? */
  reintentable: boolean;
}

/** ¿El teléfono está en formato internacional utilizable (E.164-ish)? */
export function telefonoValido(telefono: string): boolean {
  const d = telefono.replace(/[^\d]/g, "");
  return d.length >= 10 && d.length <= 15;
}

/**
 * Traduce un error crudo del transporte/envío a una causa entendible.
 * Distingue las que el operador puede corregir sin escribirnos.
 */
export function diagnosticarEnvio(errCrudo: string): DiagnosticoFallo {
  const e = errCrudo.toLowerCase();

  if (e.includes("connected") || e.includes("disconnected") ||
      e.includes("pending") || e.includes('estado "qr"')) {
    return {
      codigo: "sesion_desconectada",
      mensaje:
        "La sesión de WhatsApp estaba desconectada al enviar. Reconéctala en Sesiones (escanea el QR) y reintenta.",
      reintentable: true,
    };
  }
  if (e.includes("teléfono") && (e.includes("inválid") || e.includes("format"))) {
    return {
      codigo: "telefono_invalido",
      mensaje:
        "El teléfono no tiene un formato válido. Debe ir en internacional, p. ej. +52 55 1234 5678.",
      reintentable: false,
    };
  }
  if (e.includes("sendtext") || e.includes("rechaz") || e.includes("bad request") || e.includes("400")) {
    return {
      codigo: "transporte_rechazo",
      mensaje:
        "WhatsApp rechazó el envío. Verifica que el número exista y tenga WhatsApp, y que la sesión no esté limitada.",
      reintentable: true,
    };
  }
  return {
    codigo: "desconocido",
    mensaje: `No se pudo enviar: ${errCrudo}`,
    reintentable: true,
  };
}
