import { useCallback, useEffect, useState } from "react";
import { api, usarProveedorToken, type Yo, type Instance, type MondayVista } from "./api.ts";
import { observarSesion, type Sesion } from "./auth.ts";
import { Login } from "./Login.tsx";
import { Inicio } from "./Inicio.tsx";
import { Sesiones } from "./Sesiones.tsx";
import { Conexiones } from "./Conexiones.tsx";
import { Acciones } from "./Acciones.tsx";
import { Conversacion } from "./Conversacion.tsx";
import "./app.css";

export type Seccion = "inicio" | "sesiones" | "conexiones" | "acciones";

export default function App() {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [cargandoAuth, setCargandoAuth] = useState(true);
  const [yo, setYo] = useState<Yo | null>(null);
  const [errorProv, setErrorProv] = useState<string | null>(null);
  const [seccion, setSeccion] = useState<Seccion>("inicio");
  const [instanciaAbierta, setInstanciaAbierta] = useState<string | null>(null);

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

  // Observa la sesión de Firebase y fija el proveedor de token.
  useEffect(() => {
    return observarSesion((s) => {
      setSesion(s);
      usarProveedorToken(s ? () => s.idToken() : null);
      setCargandoAuth(false);
      if (!s) {
        setYo(null);
        setInstancias([]);
        setMonday(null);
      }
    });
  }, []);

  // Con sesión: provisiona (idempotente) y carga el tenant.
  useEffect(() => {
    if (!sesion) return;
    let vivo = true;
    (async () => {
      setErrorProv(null);
      try {
        await api.provisionar();
        const quien = await api.yo();
        if (!vivo) return;
        setYo(quien);
        await cargarProgreso(quien.tenantId);
      } catch {
        if (vivo) setErrorProv("No se pudo preparar tu cuenta. Reintenta.");
      }
    })();
    return () => {
      vivo = false;
    };
  }, [sesion, cargarProgreso]);

  if (cargandoAuth) return null;

  if (!sesion) return <Login />;

  if (!yo) {
    return (
      <main className="consola consola--angosta">
        <h1>Cauce</h1>
        <p className="consola__sub">
          {errorProv ?? "Preparando tu cuenta…"}
        </p>
        {errorProv && (
          <button className="boton" onClick={() => sesion.cerrar()}>
            Salir
          </button>
        )}
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

  const refrescar = () => cargarProgreso(yo.tenantId);
  const pasosCompletos =
    instancias.some((i) => i.estado === "connected") &&
    monday !== null &&
    hayAcciones;

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
          {yo.plan === "prueba" && (
            <span className="nav__plan">
              {yo.pruebaVigente ? "Prueba" : "Prueba vencida"}
            </span>
          )}
          <span className="nav__tenant">{sesion.email ?? yo.nombre}</span>
          <button className="boton" onClick={() => sesion.cerrar()}>
            Salir
          </button>
        </div>
      </nav>

      <div className="app__cuerpo">
        {seccion === "inicio" && (
          <Inicio
            yo={yo}
            instancias={instancias}
            hayConexion={monday !== null}
            hayAcciones={hayAcciones}
            pasosCompletos={pasosCompletos}
            irA={setSeccion}
            abrirInstancia={setInstanciaAbierta}
          />
        )}
        {seccion === "sesiones" && (
          <Sesiones yo={yo} alAbrir={setInstanciaAbierta} alCambiar={refrescar} />
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
