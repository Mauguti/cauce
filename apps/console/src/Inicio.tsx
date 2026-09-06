import { useEffect, useMemo, useState } from "react";
import type { Instance, Message, MessageEstado } from "@cauce/core";
import { api, type Yo } from "./api.ts";
import { PrimerosPasos } from "./PrimerosPasos.tsx";
import type { Seccion } from "./App.tsx";

const ETIQUETA: Record<MessageEstado, string> = {
  encolado: "En cola",
  enviando: "Enviando",
  enviado: "Enviado",
  fallido: "Fallido",
  recibido: "Recibido",
};

type Filtro = "todos" | "enviado" | "fallido" | "cola" | "recibido";

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
    let enviado = 0, fallido = 0, cola = 0, recibido = 0;
    for (const m of mensajes) {
      if (m.estado === "enviado") enviado++;
      else if (m.estado === "fallido") fallido++;
      else if (m.estado === "encolado" || m.estado === "enviando") cola++;
      else if (m.estado === "recibido") recibido++;
    }
    return { enviado, fallido, cola, recibido };
  }, [mensajes]);

  const filtrados = mensajes.filter((m) => {
    if (filtro === "todos") return true;
    if (filtro === "cola") return m.estado === "encolado" || m.estado === "enviando";
    if (filtro === "enviado") return m.estado === "enviado";
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

      <header className="seccion__cabecera">
        <h1>Hoy</h1>
        <p className="consola__sub">Qué pasó y qué falló.</p>
      </header>

      <div className="contadores">
        <Contador n={conteos.enviado} etq="Enviados" onClick={() => setFiltro("enviado")} activo={filtro === "enviado"} />
        <Contador n={conteos.fallido} etq="Con error" onClick={() => setFiltro("fallido")} activo={filtro === "fallido"} destacado={conteos.fallido > 0} />
        <Contador n={conteos.cola} etq="En cola" onClick={() => setFiltro("cola")} activo={filtro === "cola"} />
        <Contador n={conteos.recibido} etq="Recibidos" onClick={() => setFiltro("recibido")} activo={filtro === "recibido"} />
      </div>

      <div className="filtros">
        {(["todos", "enviado", "fallido", "cola", "recibido"] as Filtro[]).map((f) => (
          <button
            key={f}
            className={`chip${filtro === f ? " chip--activo" : ""}`}
            onClick={() => setFiltro(f)}
          >
            {f === "todos" ? "Todos" : f === "cola" ? "En cola" : ETIQUETA[f === "enviado" ? "enviado" : f === "fallido" ? "fallido" : "recibido"]}
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
              <tr key={m.id}>
                <td className="celda-heartbeat">{hora(m.timestamp)}</td>
                <td className="celda-numero">{m.telefono}</td>
                <td className="registro__cuerpo">{m.cuerpo}</td>
                <td>
                  <span className={`estado-envio estado-envio--${m.estado}`}>
                    {ETIQUETA[m.estado]}
                  </span>
                </td>
                <td className="celda-acciones">
                  {m.estado === "fallido" && (
                    <button
                      className="boton"
                      onClick={() => props.abrirInstancia(m.instanceId)}
                      title="Ver la conversación y la causa"
                    >
                      Ver causa
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
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
