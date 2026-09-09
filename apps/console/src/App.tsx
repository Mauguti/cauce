import { useCallback, useEffect, useState } from "react";
import {
  api,
  usarProveedorToken,
  VERSION_CONSOLA,
  type Yo,
  type Instance,
  type MondayVista,
} from "./api.ts";
import { observarSesion, type Sesion } from "./auth.ts";
import { Login } from "./Login.tsx";
import { Inicio } from "./Inicio.tsx";
import { Sesiones } from "./Sesiones.tsx";
import { Conexiones } from "./Conexiones.tsx";
import { Acciones } from "./Acciones.tsx";
import { Conversacion } from "./Conversacion.tsx";
import { Cuenta } from "./Cuenta.tsx";
import { etiquetaPlan } from "./plan.ts";
import "./app.css";

export type Seccion = "inicio" | "sesiones" | "conexiones" | "acciones";

export default function App() {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [cargandoAuth, setCargandoAuth] = useState(true);
  const [yo, setYo] = useState<Yo | null>(null);
  const [errorProv, setErrorProv] = useState<string | null>(null);
  const [seccion, setSeccion] = useState<Seccion>("inicio");
  const [instanciaAbierta, setInstanciaAbierta] = useState<string | null>(null);
  const [mostrarCuenta, setMostrarCuenta] = useState(false);

  const [instancias, setInstancias] = useState<Instance[]>([]);
  const [monday, setMonday] = useState<MondayVista | null>(null);
  const [hayAcciones, setHayAcciones] = useState(false);
  const [desfase, setDesfase] = useState<{ orq: string } | null>(null);

  // Detecta desfase consola↔orquestador comparando versiones (ver
  // docs/deploy.md). Si difieren y ninguna es "dev", avisa: recargar
  // trae la consola nueva; si es el orquestador el viejo, el aviso
  // igual evita perseguir bugs fantasma.
  useEffect(() => {
    api
      .salud()
      .then((s) => {
        if (
          VERSION_CONSOLA !== "dev" &&
          s.version !== "dev" &&
          s.version !== VERSION_CONSOLA
        ) {
          setDesfase({ orq: s.version });
        }
      })
      .catch(() => {});
  }, []);

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

  const [intentoProv, setIntentoProv] = useState(0);

  // Con sesión: provisiona (idempotente) y carga el tenant. Reintentable
  // con el botón (intentoProv) si falla la red al preparar la cuenta.
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
        if (vivo)
          setErrorProv(
            "No pudimos preparar tu cuenta. Revisa tu conexión e inténtalo de nuevo.",
          );
      }
    })();
    return () => {
      vivo = false;
    };
  }, [sesion, cargarProgreso, intentoProv]);

  const banner = desfase ? (
    <div className="banner-desfase" role="alert">
      Hay una versión más reciente disponible. Recarga la página (⌘/Ctrl+R).
      <span className="tenue"> consola {VERSION_CONSOLA} · orquestador {desfase.orq}</span>
    </div>
  ) : null;

  if (cargandoAuth) return banner;

  if (!sesion)
    return (
      <>
        {banner}
        <Login />
      </>
    );

  if (!yo) {
    return (
      <main className="consola consola--angosta">
        {banner}
        <h1>Digsol Factory</h1>
        <p className={errorProv ? "mensaje-error" : "consola__sub"}>
          {errorProv ?? "Preparando tu cuenta…"}
        </p>
        {errorProv && (
          <div className="fila-inline">
            <button
              className="boton boton--primario"
              onClick={() => setIntentoProv((n) => n + 1)}
            >
              Reintentar
            </button>
            <button className="boton" onClick={() => sesion.cerrar()}>
              Salir
            </button>
          </div>
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
      {banner}
      <nav className="nav">
        <span className="nav__marca">Digsol Factory</span>
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
          <button
            className={`nav__plan${yo.plan === "prueba" && !yo.pruebaVigente ? " nav__plan--vencido" : ""}`}
            onClick={() => setMostrarCuenta(true)}
            title="Ver tu cuenta"
          >
            {etiquetaPlan(yo)}
          </button>
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

      {mostrarCuenta && (
        <Cuenta
          yo={yo}
          lineasUsadas={instancias.length}
          conectoresUsados={monday !== null ? 1 : 0}
          alCerrar={() => setMostrarCuenta(false)}
        />
      )}
    </div>
  );
}
