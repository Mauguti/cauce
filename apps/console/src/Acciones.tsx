import { useEffect, useRef, useState } from "react";
import {
  api,
  urlWebhookMonday,
  columnaEsVariable,
  type Yo,
  type MondayVista,
  type MondayColumna,
  type RegistroMonday,
  type Message,
  type Disparador,
  type TipoDisparador,
} from "./api.ts";

export function Acciones(props: {
  yo: Yo;
  monday: MondayVista | null;
  alCambiar: () => void;
}) {
  const [tab, setTab] = useState<"salientes" | "entrantes">("salientes");
  return (
    <main className="seccion">
      <header className="seccion__cabecera">
        <h1>Acciones</h1>
        <p className="consola__sub">Qué dispara qué.</p>
      </header>

      <div className="tabs">
        <button
          className={`tab${tab === "salientes" ? " tab--activo" : ""}`}
          onClick={() => setTab("salientes")}
        >
          Salientes
        </button>
        <button
          className={`tab${tab === "entrantes" ? " tab--activo" : ""}`}
          onClick={() => setTab("entrantes")}
        >
          Entrantes
        </button>
      </div>

      {tab === "salientes" ? (
        <Salientes yo={props.yo} monday={props.monday} alCambiar={props.alCambiar} />
      ) : (
        <Entrantes yo={props.yo} />
      )}
    </main>
  );
}

const EMOJIS = ["👋", "✅", "📅", "💰", "⏰", "📎", "🙏", "😊", "🔔", "📄"];

const EJEMPLO: Record<string, string> = {
  nombre: "Ana López",
  saldo: "$1,200.00",
  fecha: "10/09/2026",
};

function Salientes(props: {
  yo: Yo;
  monday: MondayVista | null;
  alCambiar: () => void;
}) {
  const { yo } = props;
  const [plantilla, setPlantilla] = useState(props.monday?.plantilla ?? "");
  const [columnas, setColumnas] = useState<MondayColumna[]>([]);
  const [guardado, setGuardado] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [registro, setRegistro] = useState<RegistroMonday | null>(null);
  const [envios, setEnvios] = useState<Message[]>([]);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const instanceId = props.monday?.instanceId;

  useEffect(() => {
    if (!props.monday) return;
    api.monday.columnasGuardadas(yo.tenantId).then(setColumnas).catch(() => {});
    const cargar = () => {
      api.monday.registro(yo.tenantId).then(setRegistro).catch(() => {});
      if (instanceId) {
        api
          .mensajes(yo.tenantId, instanceId)
          .then((m) => setEnvios(m.filter((x) => x.direccion === "out")))
          .catch(() => {});
      }
    };
    cargar();
    const t = setInterval(cargar, 4000);
    return () => clearInterval(t);
  }, [yo.tenantId, props.monday, instanceId]);

  if (!props.monday) {
    return (
      <div className="vacio">
        <p>Primero conecta monday.</p>
        <p className="consola__sub">
          Los mensajes salientes se disparan desde tu CRM; configúralo en
          Conexiones.
        </p>
      </div>
    );
  }

  const insertar = (texto: string) => {
    const el = areaRef.current;
    if (!el) {
      setPlantilla((p) => p + texto);
      return;
    }
    const ini = el.selectionStart ?? plantilla.length;
    const fin = el.selectionEnd ?? plantilla.length;
    const nueva = plantilla.slice(0, ini) + texto + plantilla.slice(fin);
    setPlantilla(nueva);
    // Recoloca el cursor tras lo insertado.
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = ini + texto.length;
    });
  };

  const preview = plantilla.replace(
    /\{\{\s*([\w.-]+)\s*\}\}/g,
    (_m: string, k: string): string =>
      k === "nombre" ? EJEMPLO.nombre! : (EJEMPLO[k] ?? `[${k}]`),
  );

  const guardar = async () => {
    await api.monday.guardarPlantilla(yo.tenantId, plantilla).catch(() => {});
    setGuardado(true);
    props.alCambiar();
    setTimeout(() => setGuardado(false), 2000);
  };

  const url = urlWebhookMonday(yo.tenantId);

  return (
    <div className="panel">
      <p className="consola__sub">
        Board conectado; columna de teléfono:{" "}
        <strong>{props.monday.columnaTelefono}</strong>.
      </p>

      <label className="campo-etq">
        <span>Plantilla del mensaje</span>
        <div className="editor">
          <div className="editor__barra">
            <span className="editor__grupo">
              {columnas.length === 0 && (
                <span className="tenue">cargando columnas…</span>
              )}
              {columnas.filter((c) => columnaEsVariable(c.type)).map((c) => (
                <button
                  key={c.id}
                  className="chip"
                  title={`Insertar {{${c.id}}}`}
                  onClick={() => insertar(`{{${c.id}}}`)}
                >
                  {c.title}
                </button>
              ))}
              <button className="chip" onClick={() => insertar("{{nombre}}")}>
                nombre del item
              </button>
            </span>
            <span className="editor__grupo">
              {EMOJIS.map((e) => (
                <button key={e} className="chip chip--emoji" onClick={() => insertar(e)}>
                  {e}
                </button>
              ))}
            </span>
          </div>
          <textarea
            ref={areaRef}
            className="campo editor__area"
            rows={4}
            value={plantilla}
            onChange={(e) => setPlantilla(e.target.value)}
            placeholder="Hola {{nombre}}, tu saldo de {{saldo}} vence el {{fecha}}."
          />
        </div>
      </label>

      <div className="preview">
        <span className="preview__etq">Vista previa</span>
        <p className="preview__cuerpo">{preview || "…"}</p>
      </div>

      <button className="boton boton--primario" onClick={guardar}>
        {guardado ? "Guardado ✓" : "Guardar plantilla"}
      </button>

      <div className="webhook">
        <h3>Conecta el disparo en monday</h3>
        <p className="consola__sub">
          En tu board: <em>Integraciones → Webhooks</em> (o una automatización
          con acción de webhook). Pega esta URL como destino. monday enviará
          aquí el item cuando se cumpla la condición que definas allá.
        </p>
        <div className="fila-inline">
          <input className="campo webhook__url" readOnly value={url} />
          <button
            className="boton"
            onClick={() => {
              navigator.clipboard?.writeText(url).then(
                () => {
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 1500);
                },
                () => {},
              );
            }}
          >
            {copiado ? "Copiado ✓" : "Copiar"}
          </button>
        </div>

        <p className="webhook__estado">
          {registro?.ultimaLlamadaEn ? (
            <>
              monday llamó por última vez:{" "}
              <strong>{fechaLegible(registro.ultimaLlamadaEn)}</strong>
            </>
          ) : (
            <span className="tenue">
              monday aún no ha llamado a este webhook.
            </span>
          )}
        </p>
        {registro?.ultimoResultado &&
          (registro.ultimoResultado.ok ? (
            <p className="webhook__estado">
              Último disparo: enviado a {registro.ultimoResultado.telefono}{" "}
              (item {registro.ultimoResultado.itemId}) ·{" "}
              {fechaLegible(registro.ultimoResultado.en)}
            </p>
          ) : (
            <p className="mensaje-error">
              Último disparo falló: {registro.ultimoResultado.error} ·{" "}
              {fechaLegible(registro.ultimoResultado.en)}
            </p>
          ))}
      </div>

      <div className="registro">
        <h3>Registro de envíos</h3>
        {envios.length === 0 ? (
          <p className="consola__sub">Todavía no se ha enviado ningún mensaje.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>A</th>
                <th>Mensaje</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {[...envios]
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
                .slice(0, 30)
                .map((m) => (
                  <tr key={m.id}>
                    <td className="celda-heartbeat">{fechaLegible(m.timestamp)}</td>
                    <td className="celda-numero">{m.telefono}</td>
                    <td className="registro__cuerpo">{m.cuerpo}</td>
                    <td>
                      <span className={`estado-envio estado-envio--${m.estado}`}>
                        {ETIQUETA_ENVIO[m.estado] ?? m.estado}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const ETIQUETA_ENVIO: Record<string, string> = {
  encolado: "Encolado",
  enviando: "Enviando",
  enviado: "Enviado",
  fallido: "Fallido",
  recibido: "Recibido",
};

function fechaLegible(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TIPOS: { tipo: TipoDisparador; nombre: string }[] = [
  { tipo: "primer_contacto", nombre: "Primer contacto" },
  { tipo: "palabra_clave", nombre: "Palabra clave" },
  { tipo: "cualquiera", nombre: "Cualquier mensaje" },
  { tipo: "fuera_horario", nombre: "Fuera de horario" },
];

const DIAS = ["D", "L", "M", "M", "J", "V", "S"];

function Entrantes(props: { yo: Yo }) {
  const { yo } = props;
  const [lista, setLista] = useState<Disparador[]>([]);
  const [guardado, setGuardado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.disparadores(yo.tenantId).then(setLista).catch(() => {});
  }, [yo.tenantId]);

  const actualizar = (id: string, cambios: Partial<Disparador>) =>
    setLista((l) => l.map((d) => (d.id === id ? { ...d, ...cambios } : d)));

  const agregar = () => {
    const nuevo: Disparador = {
      id: crypto.randomUUID().slice(0, 8),
      prioridad: (lista.at(-1)?.prioridad ?? 0) + 10,
      tipo: "cualquiera",
      activo: true,
      respuesta: "",
    };
    setLista((l) => [...l, nuevo]);
  };

  const quitar = (id: string) => setLista((l) => l.filter((d) => d.id !== id));

  const mover = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= lista.length) return;
    const copia = [...lista];
    [copia[i], copia[j]] = [copia[j]!, copia[i]!];
    // Reasigna prioridades según el nuevo orden.
    copia.forEach((d, k) => (d.prioridad = (k + 1) * 10));
    setLista(copia);
  };

  const guardar = async () => {
    setError(null);
    for (const d of lista) {
      if (!d.respuesta.trim()) {
        setError("Cada disparador necesita un mensaje de respuesta.");
        return;
      }
      if (d.tipo === "palabra_clave" && !d.patron?.trim()) {
        setError("Los de palabra clave necesitan el texto a buscar.");
        return;
      }
    }
    try {
      await api.guardarDisparadores(yo.tenantId, lista);
      setGuardado(true);
      setTimeout(() => setGuardado(false), 2000);
    } catch (err: any) {
      setError(err?.message ?? "No se pudo guardar.");
    }
  };

  const ordenada = [...lista].sort((a, b) => a.prioridad - b.prioridad);

  return (
    <div className="panel">
      <p className="consola__sub">
        Se evalúan de arriba abajo; <strong>la primera que coincide gana</strong>{" "}
        y las demás no se evalúan. Reordena con las flechas.
      </p>

      {ordenada.length === 0 && (
        <div className="vacio">
          <p>Sin acciones entrantes.</p>
          <p className="consola__sub">
            Agrega una respuesta automática para los mensajes que llegan.
          </p>
        </div>
      )}

      <ol className="disparadores">
        {ordenada.map((d, i) => (
          <li key={d.id} className={`disparador${d.activo ? "" : " disparador--off"}`}>
            <div className="disparador__orden">
              <button className="mini" onClick={() => mover(i, -1)} disabled={i === 0} aria-label="Subir">
                ↑
              </button>
              <button className="mini" onClick={() => mover(i, 1)} disabled={i === ordenada.length - 1} aria-label="Bajar">
                ↓
              </button>
            </div>
            <div className="disparador__cuerpo">
              <div className="fila-inline">
                <select
                  className="campo"
                  value={d.tipo}
                  onChange={(e) => actualizar(d.id, { tipo: e.target.value as TipoDisparador })}
                >
                  {TIPOS.map((t) => (
                    <option key={t.tipo} value={t.tipo}>
                      {t.nombre}
                    </option>
                  ))}
                </select>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={d.activo}
                    onChange={(e) => actualizar(d.id, { activo: e.target.checked })}
                  />
                  Activo
                </label>
                <button className="boton" onClick={() => quitar(d.id)}>
                  Quitar
                </button>
              </div>

              {d.tipo === "palabra_clave" && (
                <div className="fila-inline">
                  <input
                    className="campo"
                    placeholder="Texto a buscar (p. ej. baja)"
                    value={d.patron ?? ""}
                    onChange={(e) => actualizar(d.id, { patron: e.target.value })}
                  />
                  <select
                    className="campo"
                    value={d.coincidencia ?? "contiene"}
                    onChange={(e) => actualizar(d.id, { coincidencia: e.target.value as "contiene" | "igual" })}
                  >
                    <option value="contiene">contiene</option>
                    <option value="igual">es igual a</option>
                  </select>
                </div>
              )}

              {d.tipo === "fuera_horario" && (
                <HorarioEditor
                  valor={d.horario}
                  onChange={(h) => actualizar(d.id, { horario: h })}
                />
              )}

              <textarea
                className="campo"
                rows={2}
                placeholder="Mensaje de respuesta automática"
                value={d.respuesta}
                onChange={(e) => actualizar(d.id, { respuesta: e.target.value })}
              />
            </div>
          </li>
        ))}
      </ol>

      {error && <p className="mensaje-error">{error}</p>}

      <div className="fila-inline">
        <button className="boton" onClick={agregar}>
          Agregar acción
        </button>
        <button className="boton boton--primario" onClick={guardar}>
          {guardado ? "Guardado ✓" : "Guardar acciones"}
        </button>
      </div>
    </div>
  );
}

function HorarioEditor(props: {
  valor: { tz: string; dias: number[]; desde: string; hasta: string } | undefined;
  onChange: (h: { tz: string; dias: number[]; desde: string; hasta: string }) => void;
}) {
  const h = props.valor ?? {
    tz: "America/Mexico_City",
    dias: [1, 2, 3, 4, 5],
    desde: "09:00",
    hasta: "18:00",
  };
  const toggleDia = (n: number) =>
    props.onChange({
      ...h,
      dias: h.dias.includes(n) ? h.dias.filter((x) => x !== n) : [...h.dias, n],
    });

  return (
    <div className="horario">
      <span className="tenue">Horario laboral (se responde fuera de él):</span>
      <div className="horario__dias">
        {DIAS.map((etq, n) => (
          <button
            key={n}
            className={`mini${h.dias.includes(n) ? " mini--on" : ""}`}
            onClick={() => toggleDia(n)}
          >
            {etq}
          </button>
        ))}
      </div>
      <div className="fila-inline">
        <input
          className="campo"
          type="time"
          value={h.desde}
          onChange={(e) => props.onChange({ ...h, desde: e.target.value })}
        />
        <span className="tenue">a</span>
        <input
          className="campo"
          type="time"
          value={h.hasta}
          onChange={(e) => props.onChange({ ...h, hasta: e.target.value })}
        />
        <input
          className="campo"
          value={h.tz}
          onChange={(e) => props.onChange({ ...h, tz: e.target.value })}
        />
      </div>
    </div>
  );
}
