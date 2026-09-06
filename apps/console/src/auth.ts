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

/**
 * Firebase Auth vive en `digsol-fabrica-de-empleados` — el MISMO proyecto
 * cuyas credenciales usa el orquestador (firebase-admin) para verificar
 * los ID tokens. Debe coincidir: verifyIdToken exige que el token venga
 * del proyecto del Admin SDK. (`cauce-consola` es solo Hosting y NO tiene
 * Identity Toolkit provisionado: por eso signUp daba 404/CONFIGURATION_NOT_FOUND.)
 */
const firebaseConfig = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY as string) ??
    "AIzaSyAkpWBNwwhtrlUHV_b2NKwNXiuTtKe4vXU",
  authDomain:
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string) ??
    "digsol-fabrica-de-empleados.firebaseapp.com",
  projectId: "digsol-fabrica-de-empleados",
  appId: "1:381790209518:web:b9d0aa290221658a78faff",
  messagingSenderId: "381790209518",
  storageBucket: "digsol-fabrica-de-empleados.firebasestorage.app",
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
