/**
 * Verificación de ID tokens de Firebase. En producción usa el Admin SDK
 * (credenciales de GOOGLE_APPLICATION_CREDENTIALS, las mismas de
 * Firestore). En desarrollo/pruebas, con CAUCE_AUTH_DEV=1, acepta tokens
 * de la forma `dev:<uid>:<email>` SIN verificación criptográfica — nunca
 * en producción.
 */
export interface Identidad {
  uid: string;
  email: string | null;
  nombre: string | null;
}

export type VerificadorToken = (idToken: string) => Promise<Identidad>;

/** ¿Parece un JWT (tres segmentos separados por punto)? */
export function pareceJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function verificadorDev(): VerificadorToken {
  return async (idToken: string) => {
    // Formato: dev:<uid>[:<email>]
    const partes = idToken.replace(/^dev:/, "").split(":");
    const uid = partes[0];
    if (!idToken.startsWith("dev:") || !uid) {
      throw new Error("token dev inválido");
    }
    return {
      uid,
      email: partes[1] ?? null,
      nombre: partes[1]?.split("@")[0] ?? null,
    };
  };
}

function verificadorAdmin(): VerificadorToken {
  // Import perezoso: firebase-admin es pesado y no hace falta en dev.
  let appPromesa: Promise<any> | null = null;
  const getApp = async () => {
    if (!appPromesa) {
      appPromesa = (async () => {
        const admin = await import("firebase-admin");
        if (admin.apps.length === 0) {
          admin.initializeApp(); // credenciales por ADC (GOOGLE_APPLICATION_CREDENTIALS)
        }
        return admin;
      })();
    }
    return appPromesa;
  };
  return async (idToken: string) => {
    const admin = await getApp();
    const decoded = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      nombre: decoded.name ?? decoded.email?.split("@")[0] ?? null,
    };
  };
}

export function crearVerificadorToken(): VerificadorToken {
  if (process.env.CAUCE_AUTH_DEV === "1") {
    console.warn(
      "CAUCE_AUTH_DEV=1: los ID tokens NO se verifican criptográficamente (solo desarrollo)",
    );
    return verificadorDev();
  }
  return verificadorAdmin();
}
