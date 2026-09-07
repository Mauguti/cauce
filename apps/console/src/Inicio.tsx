import { useEffect, useMemo, useState } from "react";
import {
  sesionPareceDegradada,
  type Instance,
  type Message,
  type MessageEstado,
} from "@cauce/core";
import { api, type Yo, type Conversacion } from "./api.ts";
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
  const [conversaciones, setConversaciones] = useState<Conversacion[]>([]);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());
  // Los primeros pasos se colapsan cuando están completos; se pueden reabrir.
  const [pasosAbiertos, setPasosAbiertos] = useState(!props.pasosCompletos);

  useEffect(() => {
    const cargar = () => {
      api.mensajesTenant(props.yo.tenantId).then(setMensajes).catch(() => {});
      api.conversaciones(props.yo.tenantId).then(setConversaciones).catch(() => {});
    };
    cargar();
    const t = setInterval(cargar, 4000);
    return () => clearInterval(t);
  }, [props.yo.tenantId]);

  // Mapa teléfono (solo dígitos) → contexto, para mostrar nombre o item de
  // monday en vez del número crudo.
  const contexto = useMemo(() => {
    const m = new Map<string, Conversacion>();
    for (const c of conversaciones) m.set(c.telefono.replace(/[^\d]/g, ""), c);
    return m;
  }, [conversaciones]);

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
        <Registro
          mensajes={filtrados.slice(0, 100)}
          contexto={contexto}
          tenantId={props.yo.tenantId}
          expandidos={expandidos}
          alExpandir={(id) =>
            setExpandidos((s) => {
              const n = new Set(s);
              n.has(id) ? n.delete(id) : n.add(id);
              return n;
            })
          }
          abrirInstancia={props.abrirInstancia}
        />
      )}
    </main>
  );
}

/**
 * Registro de mensajes como bitácora agrupada por día. Está pensado para
 * leerse de un vistazo: la dirección (enviado/recibido) salta sin leer el
 * estado, el mensaje tiene aire y el estado solo grita cuando algo falló.
 */
function Registro(props: {
  mensajes: Message[];
  contexto: Map<string, Conversacion>;
  tenantId: string;
  expandidos: Set<string>;
  alExpandir: (id: string) => void;
  abrirInstancia: (id: string) => void;
}) {
  const grupos = agruparPorDia(props.mensajes);
  // El día vive en la cabecera; los renglones muestran solo la hora. Se
  // omite la cabecera única cuando todo es de hoy.
  const mostrarDias =
    grupos.length > 1 || (grupos.length === 1 && grupos[0]!.dia !== "Hoy");

  return (
    <div className="bitacora">
      {grupos.map((g) => (
        <section key={g.dia} className="bitacora__dia">
          {mostrarDias && <h3 className="bitacora__fecha">{g.dia}</h3>}
          <ul className="bitacora__lista">
            {g.items.map((m) => (
              <FilaMensaje
                key={m.id}
                m={m}
                contacto={etiquetaContacto(m, props.contexto)}
                tenantId={props.tenantId}
                expandido={props.expandidos.has(m.id)}
                alExpandir={() => props.alExpandir(m.id)}
                abrirInstancia={props.abrirInstancia}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// Los fallos que NO se corrigen reintentando el mismo mensaje.
const NO_REINTENTABLE = new Set(["telefono_vacio", "telefono_invalido", "item_incompleto"]);
// Estados que deben resaltar (todo lo demás es "normal" y va discreto).
const ESTADO_NOTABLE = new Set<MessageEstado>(["fallido", "no_confirmado"]);

function FilaMensaje(props: {
  m: Message;
  contacto: string;
  tenantId: string;
  expandido: boolean;
  alExpandir: () => void;
  abrirInstancia: (id: string) => void;
}) {
  const { m } = props;
  const saliente = m.direccion === "out";
  const [estado, setEstado] = useState<"idle" | "reintentando" | "reintentado" | "error">("idle");
  const [errRetry, setErrRetry] = useState<string | null>(null);

  const puedeReintentar =
    m.estado === "fallido" && !NO_REINTENTABLE.has(m.errorCodigo ?? "");
  const notable = ESTADO_NOTABLE.has(m.estado);
  const enProgreso = m.estado === "encolado" || m.estado === "enviando";

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
    <li className={`msj msj--${saliente ? "out" : "in"}`}>
      <span
        className="msj__dir"
        title={saliente ? "Enviado" : "Recibido"}
        aria-label={saliente ? "Enviado" : "Recibido"}
      >
        {saliente ? "→" : "←"}
      </span>

      <div className="msj__cuerpo">
        <div className="msj__cabecera">
          <span className="msj__contacto">{props.contacto}</span>
          <span className="msj__hora">{horaCorta(m.timestamp)}</span>
        </div>
        <p
          className={`msj__texto${props.expandido ? "" : " msj__texto--corto"}`}
          onClick={props.alExpandir}
          title={props.expandido ? "" : "Ver completo"}
        >
          {m.cuerpo || <span className="tenue">(vacío)</span>}
        </p>

        {(notable || enProgreso) && (
          <div className="msj__pie">
            {notable ? (
              <span className={`marca marca--${m.estado}`}>{ETIQUETA[m.estado]}</span>
            ) : (
              <span className="tenue">{ETIQUETA[m.estado]}</span>
            )}
            {m.estado === "fallido" && (m.error || errRetry) && (
              <span className="msj__causa">{errRetry ?? m.error}</span>
            )}
            {m.estado === "fallido" && puedeReintentar && estado !== "reintentado" && (
              <button className="boton mini-link" onClick={reintentar} disabled={estado === "reintentando"}>
                {estado === "reintentando" ? "Reintentando…" : "Reintentar"}
              </button>
            )}
            {estado === "reintentado" && <span className="tenue">Reencolado ✓</span>}
            {(m.estado === "fallido" && !puedeReintentar && !errRetry) ||
            m.estado === "no_confirmado" ? (
              <button className="boton mini-link" onClick={() => props.abrirInstancia(m.instanceId)}>
                Ver conversación
              </button>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}

/** Etiqueta legible del contacto: nombre, item de monday, o teléfono. */
function etiquetaContacto(m: Message, ctx: Map<string, Conversacion>): string {
  const c = ctx.get(m.telefono.replace(/[^\d]/g, ""));
  if (c?.nombre && c.nombre.trim()) return c.nombre.trim();
  if (c?.mondayItemId) return `monday · item ${c.mondayItemId}`;
  return formatearTelefono(m.telefono);
}

/** Agrupa mensajes (ya ordenados desc) en secciones por día. */
function agruparPorDia(
  mensajes: Message[],
): { dia: string; items: Message[] }[] {
  const hoy = new Date();
  const grupos: { dia: string; items: Message[] }[] = [];
  for (const m of mensajes) {
    const dia = diaLabel(m.timestamp, hoy);
    const ultimo = grupos.at(-1);
    if (ultimo && ultimo.dia === dia) ultimo.items.push(m);
    else grupos.push({ dia, items: [m] });
  }
  return grupos;
}

function mismoDia(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function diaLabel(iso: string, hoy: Date): string {
  const d = new Date(iso);
  if (mismoDia(d, hoy)) return "Hoy";
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (mismoDia(d, ayer)) return "Ayer";
  return d.toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== hoy.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Hora en una línea (el día lo da la cabecera de sección). */
function horaCorta(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Teléfono legible: agrupa el número nacional (últimos 10 dígitos). */
function formatearTelefono(tel: string): string {
  const d = tel.replace(/[^\d]/g, "");
  if (d.length < 10) return tel;
  const nac = d.slice(-10);
  const pais = d.slice(0, -10);
  const g = nac.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3");
  return `${pais ? `+${pais} ` : ""}${g}`.trim();
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
