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
    // Forma A (curl): dev:<uid>[:<email>]
    if (idToken.startsWith("dev:")) {
      const partes = idToken.slice(4).split(":");
      const uid = partes[0];
      if (!uid) throw new Error("token dev inválido");
      return { uid, email: partes[1] ?? null, nombre: partes[1]?.split("@")[0] ?? null };
    }
    // Forma B (consola): JWT SIN FIRMAR; se decodifica el payload sin
    // verificar (solo válido en modo dev). uid = sub.
    const seg = idToken.split(".");
    if (seg.length === 3 && seg[1]) {
      try {
        const payload = JSON.parse(
          Buffer.from(seg[1], "base64url").toString("utf8"),
        );
        const uid = payload.sub ?? payload.user_id ?? payload.uid;
        if (uid) {
          return {
            uid: String(uid),
            email: payload.email ?? null,
            nombre: payload.name ?? payload.email?.split("@")[0] ?? null,
          };
        }
      } catch {
        // cae al throw de abajo
      }
    }
    throw new Error("token dev inválido");
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
