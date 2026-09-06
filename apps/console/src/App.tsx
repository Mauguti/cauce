import { useCallback, useEffect, useState } from "react";
import {
  api,
  apiKeyGuardada,
  guardarApiKey,
  olvidarApiKey,
  ErrorNoAutorizado,
  type Yo,
  type Instance,
  type MondayVista,
} from "./api.ts";
import { Sesiones } from "./Sesiones.tsx";
import { Conexiones } from "./Conexiones.tsx";
import { Acciones } from "./Acciones.tsx";
import { Conversacion } from "./Conversacion.tsx";
import { PrimerosPasos } from "./PrimerosPasos.tsx";
import "./app.css";

type Seccion = "inicio" | "sesiones" | "conexiones" | "acciones";

export default function App() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [probando, setProbando] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [seccion, setSeccion] = useState<Seccion>("inicio");
  const [instanciaAbierta, setInstanciaAbierta] = useState<string | null>(null);

  // Progreso de onboarding, para el estado vacío y los primeros pasos.
  const [instancias, setInstancias] = useState<Instance[]>([]);
  const [monday, setMonday] = useState<MondayVista | null>(null);
  const [hayAcciones, setHayAcciones] = useState(false);

  const cargarProgreso = useCallback(async (t: string) => {
    const [insts, mon, disp] = await Promise.all([
      api.instancias(t).catch(() => []),
      api.monday.ver(t).catch(() => null),
      api.disparadores(t).catch(() => []),
    ]);
    setInstancias(insts);
    setMonday(mon);
    setHayAcciones((disp?.length ?? 0) > 0 || mon !== null);
  }, []);

  useEffect(() => {
    const key = apiKeyGuardada();
    if (!key) {
      setProbando(false);
      return;
    }
    api
      .yo(key)
      .then((quien) => {
        setYo(quien);
        return cargarProgreso(quien.tenantId);
      })
      .catch(() => olvidarApiKey())
      .finally(() => setProbando(false));
  }, [cargarProgreso]);

  const entrar = useCallback(
    async (key: string) => {
      setErrorKey(null);
      try {
        const quien = await api.yo(key);
        guardarApiKey(key);
        setYo(quien);
        await cargarProgreso(quien.tenantId);
      } catch (err) {
        setErrorKey(
          err instanceof ErrorNoAutorizado
            ? "La key no es válida."
            : "No se pudo contactar al orquestador.",
        );
      }
    },
    [cargarProgreso],
  );

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

  if (instanciaAbierta) {
    return (
      <Conversacion
        tenantId={yo.tenantId}
        instanceId={instanciaAbierta}
        alVolver={() => setInstanciaAbierta(null)}
      />
    );
  }

  const hayNumeroConectado = instancias.some((i) => i.estado === "connected");
  const refrescar = () => cargarProgreso(yo.tenantId);

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav__marca">Cauce</span>
        <div className="nav__links">
          {(["inicio", "sesiones", "conexiones", "acciones"] as Seccion[]).map(
            (s) => (
              <button
                key={s}
                className={`nav__link${seccion === s ? " nav__link--activo" : ""}`}
                onClick={() => setSeccion(s)}
              >
                {s === "inicio"
                  ? "Inicio"
                  : s === "sesiones"
                    ? "Sesiones"
                    : s === "conexiones"
                      ? "Conexiones"
                      : "Acciones"}
              </button>
            ),
          )}
        </div>
        <div className="nav__cuenta">
          <span className="nav__tenant">{yo.nombre}</span>
          <button
            className="boton"
            onClick={() => {
              olvidarApiKey();
              setYo(null);
            }}
          >
            Salir
          </button>
        </div>
      </nav>

      <div className="app__cuerpo">
        {seccion === "inicio" && (
          <PrimerosPasos
            hayNumeroConectado={hayNumeroConectado}
            hayConexion={monday !== null}
            hayAcciones={hayAcciones}
            irA={setSeccion}
          />
        )}
        {seccion === "sesiones" && (
          <Sesiones
            yo={yo}
            alAbrir={setInstanciaAbierta}
            alCambiar={refrescar}
          />
        )}
        {seccion === "conexiones" && (
          <Conexiones yo={yo} instancias={instancias} alCambiar={refrescar} />
        )}
        {seccion === "acciones" && (
          <Acciones yo={yo} monday={monday} alCambiar={refrescar} />
        )}
      </div>
    </div>
  );
}
