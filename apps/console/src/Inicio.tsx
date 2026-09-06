import { useEffect, useMemo, useState } from "react";
import {
  sesionPareceDegradada,
  type Instance,
  type Message,
  type MessageEstado,
} from "@cauce/core";
import { api, type Yo } from "./api.ts";
import { PrimerosPasos } from "./PrimerosPasos.tsx";
import type { Seccion } from "./App.tsx";

const ETIQUETA: Record<MessageEstado, string> = {
  encolado: "En cola",
  enviando: "Enviando",
  enviado: "Enviado",
  no_confirmado: "Sin confirmar",
  fallido: "Fallido",
  recibido: "Recibido",
};

type Filtro = "todos" | "enviado" | "sin_confirmar" | "fallido" | "cola" | "recibido";

export function Inicio(props: {
  yo: Yo;
  instancias: Instance[];
  hayConexion: boolean;
  hayAcciones: boolean;
  pasosCompletos: boolean;
  irA: (s: Seccion) => void;
  abrirInstancia: (id: string) => void;
}) {
  const [mensajes, setMensajes] = useState<Message[]>([]);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  // Los primeros pasos se colapsan cuando están completos; se pueden reabrir.
  const [pasosAbiertos, setPasosAbiertos] = useState(!props.pasosCompletos);

  useEffect(() => {
    const cargar = () =>
      api.mensajesTenant(props.yo.tenantId).then(setMensajes).catch(() => {});
    cargar();
    const t = setInterval(cargar, 4000);
    return () => clearInterval(t);
  }, [props.yo.tenantId]);

  const conteos = useMemo(() => {
    let enviado = 0, sinConfirmar = 0, fallido = 0, cola = 0, recibido = 0;
    for (const m of mensajes) {
      if (m.estado === "enviado") enviado++;
      else if (m.estado === "no_confirmado") sinConfirmar++;
      else if (m.estado === "fallido") fallido++;
      else if (m.estado === "encolado" || m.estado === "enviando") cola++;
      else if (m.estado === "recibido") recibido++;
    }
    return { enviado, sinConfirmar, fallido, cola, recibido };
  }, [mensajes]);

  // Instancias cuya sesión parece degradada (varios salientes sin confirmar
  // seguidos): el patrón del bug PENDING. Se avisa con su número.
  const degradadas = useMemo(
    () =>
      props.instancias.filter((inst) =>
        sesionPareceDegradada(
          mensajes.filter((m) => m.instanceId === inst.id),
        ),
      ),
    [mensajes, props.instancias],
  );

  const filtrados = mensajes.filter((m) => {
    if (filtro === "todos") return true;
    if (filtro === "cola") return m.estado === "encolado" || m.estado === "enviando";
    if (filtro === "enviado") return m.estado === "enviado";
    if (filtro === "sin_confirmar") return m.estado === "no_confirmado";
    if (filtro === "fallido") return m.estado === "fallido";
    if (filtro === "recibido") return m.estado === "recibido";
    return true;
  });

  return (
    <main className="seccion">
      {props.pasosCompletos ? (
        <button
          className="pasos-colapsado"
          onClick={() => setPasosAbiertos((v) => !v)}
        >
          <span>✓ Configuración completa</span>
          <span className="tenue">{pasosAbiertos ? "ocultar" : "ver pasos"}</span>
        </button>
      ) : null}

      {(!props.pasosCompletos || pasosAbiertos) && (
        <div className="pasos-envoltura">
          <PrimerosPasos
            hayNumeroConectado={props.instancias.some((i) => i.estado === "connected")}
            hayConexion={props.hayConexion}
            hayAcciones={props.hayAcciones}
            irA={props.irA}
          />
        </div>
      )}

      {props.yo.plan === "prueba" && !props.yo.pruebaVigente && (
        <p className="aviso-prueba">
          Tu prueba terminó. Tus sesiones se desconectaron y tus datos siguen
          guardados. Contrata un plan para reconectar.
        </p>
      )}

      {degradadas.length > 0 && (
        <div className="aviso-degradada" role="alert">
          <strong>
            Tu número{degradadas.length > 1 ? "s" : ""}{" "}
            {degradadas.map((i) => i.numero ?? "conectado").join(", ")} puede
            estar degradado.
          </strong>{" "}
          Varios mensajes salieron pero WhatsApp no confirmó que llegaran (se
          quedan "sin confirmar"). Suele pasar cuando un número se creó y borró
          muchas veces. Qué hacer: en Sesiones, <em>desconecta y reconéctalo</em>{" "}
          escaneando el QR de nuevo. Si sigue igual, el número necesita
          descansar unas horas antes de volver a usarlo.
        </div>
      )}

      <header className="seccion__cabecera">
        <h1>Hoy</h1>
        <p className="consola__sub">Qué pasó y qué falló.</p>
      </header>

      <div className="contadores">
        <Contador n={conteos.enviado} etq="Enviados" onClick={() => setFiltro("enviado")} activo={filtro === "enviado"} />
        <Contador n={conteos.sinConfirmar} etq="Sin confirmar" onClick={() => setFiltro("sin_confirmar")} activo={filtro === "sin_confirmar"} destacado={conteos.sinConfirmar > 0} />
        <Contador n={conteos.fallido} etq="Con error" onClick={() => setFiltro("fallido")} activo={filtro === "fallido"} destacado={conteos.fallido > 0} />
        <Contador n={conteos.cola} etq="En cola" onClick={() => setFiltro("cola")} activo={filtro === "cola"} />
        <Contador n={conteos.recibido} etq="Recibidos" onClick={() => setFiltro("recibido")} activo={filtro === "recibido"} />
      </div>

      <div className="filtros">
        {(["todos", "enviado", "sin_confirmar", "fallido", "cola", "recibido"] as Filtro[]).map((f) => (
          <button
            key={f}
            className={`chip${filtro === f ? " chip--activo" : ""}`}
            onClick={() => setFiltro(f)}
          >
            {f === "todos"
              ? "Todos"
              : f === "cola"
                ? "En cola"
                : f === "sin_confirmar"
                  ? "Sin confirmar"
                  : ETIQUETA[f === "enviado" ? "enviado" : f === "fallido" ? "fallido" : "recibido"]}
          </button>
        ))}
      </div>

      {filtrados.length === 0 ? (
        <div className="vacio">
          <p>Sin mensajes {filtro === "todos" ? "todavía" : "en este estado"}.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Destinatario</th>
              <th>Mensaje</th>
              <th>Estado</th>
              <th aria-label="acción" />
            </tr>
          </thead>
          <tbody>
            {filtrados.slice(0, 100).map((m) => (
              <FilaMensaje
                key={m.id}
                m={m}
                tenantId={props.yo.tenantId}
                abrirInstancia={props.abrirInstancia}
              />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

// Los fallos que NO se corrigen reintentando el mismo mensaje.
const NO_REINTENTABLE = new Set(["telefono_vacio", "telefono_invalido", "item_incompleto"]);

function FilaMensaje(props: {
  m: Message;
  tenantId: string;
  abrirInstancia: (id: string) => void;
}) {
  const { m } = props;
  const [estado, setEstado] = useState<"idle" | "reintentando" | "reintentado" | "error">("idle");
  const [errRetry, setErrRetry] = useState<string | null>(null);

  const puedeReintentar =
    m.estado === "fallido" && !NO_REINTENTABLE.has(m.errorCodigo ?? "");

  const reintentar = async () => {
    setEstado("reintentando");
    setErrRetry(null);
    try {
      await api.reintentar(props.tenantId, m.id);
      setEstado("reintentado");
    } catch (e: any) {
      setEstado("error");
      setErrRetry(e?.message ?? "No se pudo reintentar.");
    }
  };

  return (
    <>
      <tr>
        <td className="celda-heartbeat">{hora(m.timestamp)}</td>
        <td className="celda-numero">{m.telefono}</td>
        <td className="registro__cuerpo">{m.cuerpo || <span className="tenue">(vacío)</span>}</td>
        <td>
          <span className={`estado-envio estado-envio--${m.estado}`}>
            {ETIQUETA[m.estado]}
          </span>
        </td>
        <td className="celda-acciones">
          {m.estado === "fallido" && puedeReintentar && estado !== "reintentado" && (
            <button className="boton" onClick={reintentar} disabled={estado === "reintentando"}>
              {estado === "reintentando" ? "Reintentando…" : "Reintentar"}
            </button>
          )}
          {estado === "reintentado" && <span className="tenue">Reencolado ✓</span>}
        </td>
      </tr>
      {m.estado === "fallido" && (m.error || errRetry) && (
        <tr className="fila-causa">
          <td />
          <td colSpan={4}>
            <span className="causa">{errRetry ?? m.error}</span>
            {!puedeReintentar && !errRetry && (
              <button
                className="boton mini-link"
                onClick={() => props.abrirInstancia(m.instanceId)}
              >
                Ver conversación
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Contador(props: {
  n: number;
  etq: string;
  onClick: () => void;
  activo: boolean;
  destacado?: boolean;
}) {
  return (
    <button
      className={`contador${props.activo ? " contador--activo" : ""}${props.destacado ? " contador--alerta" : ""}`}
      onClick={props.onClick}
    >
      <span className="contador__n">{props.n}</span>
      <span className="contador__etq">{props.etq}</span>
    </button>
  );
}

function hora(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
