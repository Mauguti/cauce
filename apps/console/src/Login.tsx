import { useState } from "react";
import {
  esDev,
  entrarDev,
  entrarEmail,
  registrarEmail,
  entrarGoogle,
} from "./auth.ts";

export function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [modo, setModo] = useState<"entrar" | "registrar">("entrar");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOcupado(true);
    try {
      if (esDev) {
        await entrarDev(email.trim());
      } else if (modo === "registrar") {
        await registrarEmail(email.trim(), pass);
      } else {
        await entrarEmail(email.trim(), pass);
      }
    } catch (err: any) {
      setError(traducir(err?.code ?? "") ?? "No se pudo continuar.");
    } finally {
      setOcupado(false);
    }
  };

  const conGoogle = async () => {
    setError(null);
    try {
      await entrarGoogle();
    } catch {
      setError("No se pudo entrar con Google.");
    }
  };

  return (
    <main className="consola consola--angosta">
      <h1>Cauce</h1>
      <p className="consola__sub">
        {modo === "registrar"
          ? "Crea tu cuenta para empezar."
          : "Entra a tu cuenta."}
        {esDev && " (modo desarrollo)"}
      </p>

      <form className="login" onSubmit={enviar}>
        <input
          className="campo"
          type="email"
          placeholder="tu@correo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        {!esDev && (
          <input
            className="campo"
            type="password"
            placeholder="Contraseña"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            required
            minLength={6}
          />
        )}
        <button className="boton boton--primario" type="submit" disabled={ocupado}>
          {esDev
            ? "Entrar (dev)"
            : modo === "registrar"
              ? "Crear cuenta"
              : "Entrar"}
        </button>
      </form>

      {!esDev && (
        <>
          <button className="boton login__google" onClick={conGoogle}>
            Continuar con Google
          </button>
          <button
            className="login__cambiar"
            onClick={() => setModo(modo === "entrar" ? "registrar" : "entrar")}
          >
            {modo === "entrar"
              ? "¿No tienes cuenta? Regístrate"
              : "¿Ya tienes cuenta? Entra"}
          </button>
        </>
      )}

      {error && <p className="mensaje-error">{error}</p>}
    </main>
  );
}

function traducir(code: string): string | null {
  const m: Record<string, string> = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/wrong-password": "Correo o contraseña incorrectos.",
    "auth/user-not-found": "No hay cuenta con ese correo.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese correo.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/invalid-email": "Correo inválido.",
  };
  return m[code] ?? null;
}
