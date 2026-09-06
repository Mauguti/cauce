import { useCallback, useEffect, useState } from "react";
import {
  api,
  apiKeyGuardada,
  guardarApiKey,
  olvidarApiKey,
  ErrorNoAutorizado,
  type Yo,
} from "./api.ts";
import { Sesiones } from "./Sesiones.tsx";
import { Conversacion } from "./Conversacion.tsx";
import "./app.css";

export default function App() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [probando, setProbando] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [instanciaAbierta, setInstanciaAbierta] = useState<string | null>(null);

  useEffect(() => {
    const key = apiKeyGuardada();
    if (!key) {
      setProbando(false);
      return;
    }
    api
      .yo(key)
      .then(setYo)
      .catch(() => olvidarApiKey())
      .finally(() => setProbando(false));
  }, []);

  const entrar = useCallback(async (key: string) => {
    setErrorKey(null);
    try {
      const quien = await api.yo(key);
      guardarApiKey(key);
      setYo(quien);
    } catch (err) {
      setErrorKey(
        err instanceof ErrorNoAutorizado
          ? "La key no es válida."
          : "No se pudo contactar al orquestador.",
      );
    }
  }, []);

  if (probando) return null;

  if (!yo) {
    return (
      <main className="consola consola--angosta">
        <h1>Cauce</h1>
        <p className="consola__sub">Ingresa la API key de tu cuenta.</p>
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            const key = new FormData(e.currentTarget).get("key");
            if (typeof key === "string" && key.trim()) void entrar(key.trim());
          }}
        >
          <input
            className={`campo${errorKey ? " campo--error" : ""}`}
            name="key"
            type="password"
            placeholder="API key"
            autoFocus
          />
          <button className="boton boton--primario" type="submit">
            Entrar
          </button>
        </form>
        {errorKey && <p className="mensaje-error">{errorKey}</p>}
      </main>
    );
  }

  return instanciaAbierta ? (
    <Conversacion
      tenantId={yo.tenantId}
      instanceId={instanciaAbierta}
      alVolver={() => setInstanciaAbierta(null)}
    />
  ) : (
    <Sesiones
      yo={yo}
      alAbrir={setInstanciaAbierta}
      alSalir={() => {
        olvidarApiKey();
        setYo(null);
      }}
    />
  );
}
