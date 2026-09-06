import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";

/**
 * Autenticación de la consola. En producción usa Firebase Auth
 * (email/contraseña + Google) y entrega el ID token de Firebase. Con
 * VITE_AUTH_DEV=1 (desarrollo local) omite Firebase y produce un JWT SIN
 * FIRMAR — el orquestador con CAUCE_AUTH_DEV lo acepta sin verificar.
 */
const DEV = import.meta.env.VITE_AUTH_DEV === "1";

const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY as string) ??
    "AIzaSyDhbsPLNdhBWOZbzFMBezXbSPLV3hRJR9k",
  authDomain: "cauce-consola.firebaseapp.com",
  projectId: "cauce-consola",
  appId: "1:315987302649:web:8c107ab5f9624f1b4eea28",
};

// ---- Modo dev: JWT sin firmar ----
function jwtDev(email: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = { sub: `dev-${email}`, email, name: email.split("@")[0] };
  return `${b64({ alg: "none" })}.${b64(payload)}.dev`;
}

export interface Sesion {
  idToken: () => Promise<string>;
  email: string | null;
  cerrar: () => Promise<void>;
}

let devEmail: string | null = null;
const devListeners = new Set<(s: Sesion | null) => void>();

function sesionDev(email: string): Sesion {
  return {
    idToken: async () => jwtDev(email),
    email,
    cerrar: async () => {
      devEmail = null;
      for (const l of devListeners) l(null);
    },
  };
}

const app = DEV ? null : initializeApp(firebaseConfig);
const auth = app ? getAuth(app) : null;

function sesionFirebase(user: User): Sesion {
  return {
    idToken: () => user.getIdToken(),
    email: user.email,
    cerrar: () => fbSignOut(auth!),
  };
}

/** Observa la sesión actual; llama cb con la sesión o null. */
export function observarSesion(cb: (s: Sesion | null) => void): () => void {
  if (DEV) {
    devListeners.add(cb);
    cb(devEmail ? sesionDev(devEmail) : null);
    return () => devListeners.delete(cb);
  }
  return onAuthStateChanged(auth!, (u) => cb(u ? sesionFirebase(u) : null));
}

export const esDev = DEV;

export async function entrarDev(email: string): Promise<void> {
  devEmail = email;
  for (const l of devListeners) l(sesionDev(email));
}

export async function entrarEmail(email: string, pass: string): Promise<void> {
  await signInWithEmailAndPassword(auth!, email, pass);
}

export async function registrarEmail(email: string, pass: string): Promise<void> {
  await createUserWithEmailAndPassword(auth!, email, pass);
}

export async function entrarGoogle(): Promise<void> {
  await signInWithPopup(auth!, new GoogleAuthProvider());
}
