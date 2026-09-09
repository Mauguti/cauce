import { useEffect, useRef, useState } from "react";
import {
  api,
  urlWebhookMonday,
  urlWebhookBitrix,
  columnaEsVariable,
  type Yo,
  type MondayVista,
  type BitrixVista,
  type Message,
  type Disparador,
  type TipoDisparador,
  type PlantillaSaliente,
} from "./api.ts";

// Id de la plantilla por defecto (espejo del backend): responde también en
// la URL corta ya configurada en las automatizaciones existentes.
const PLANTILLA_DEFECTO_ID = "default";

/**
 * Adaptador de un conector para la UI de plantillas salientes. Abstrae lo
 * único que cambia entre monday y Bitrix (de dónde salen los campos, la URL
 * del webhook, la API); todo lo demás —listar, editar, quitar plantillas—
 * es igual para ambos.
 */
export interface ConectorAdapter {
  tipo: "monday" | "bitrix";
  instanceId: string;
  contexto: string;
  urlWebhook: (plantillaId?: string) => string;
  cargarCampos: () => Promise<{ id: string; title: string }[]>;
  verPlantillas: () => Promise<PlantillaSaliente[]>;
  guardarPlantillas: (lista: PlantillaSaliente[]) => Promise<void>;
}

function adaptadorMonday(yo: Yo, v: MondayVista): ConectorAdapter {
  return {
    tipo: "monday",
    instanceId: v.instanceId,
    contexto: `Board conectado; columna de teléfono: ${v.columnaTelefono}.`,
    urlWebhook: (id) => urlWebhookMonday(yo.tenantId, id === PLANTILLA_DEFECTO_ID ? undefined : id),
    cargarCampos: () =>
      api.monday
        .columnasGuardadas(yo.tenantId)
        .then((cs) => cs.filter((c) => columnaEsVariable(c.type)).map((c) => ({ id: c.id, title: c.title }))),
    verPlantillas: () => api.monday.ver(yo.tenantId).then((x) => x?.plantillas ?? []),
    guardarPlantillas: (lista) => api.monday.guardarPlantillas(yo.tenantId, lista),
  };
}

function adaptadorBitrix(yo: Yo, v: BitrixVista): ConectorAdapter {
  return {
    tipo: "bitrix",
    instanceId: v.instanceId,
    contexto: `Bitrix conectado (${v.entidad}); teléfono en el campo: ${v.campoTelefono}.`,
    urlWebhook: (id) => urlWebhookBitrix(yo.tenantId, id === PLANTILLA_DEFECTO_ID ? undefined : id),
    cargarCampos: () =>
      api.bitrix.camposGuardados(yo.tenantId).then((cs) => cs.map((c) => ({ id: c.id, title: c.title }))),
    verPlantillas: () => api.bitrix.ver(yo.tenantId).then((x) => x?.plantillas ?? []),
    guardarPlantillas: (lista) => api.bitrix.guardarPlantillas(yo.tenantId, lista),
  };
}

export function Acciones(props: {
  yo: Yo;
  monday: MondayVista | null;
  alCambiar: () => void;
}) {
  const [tab, setTab] = useState<"salientes" | "entrantes">("salientes");
  const [bitrix, setBitrix] = useState<BitrixVista | null>(null);

  useEffect(() => {
    api.bitrix.ver(props.yo.tenantId).then(setBitrix).catch(() => {});
  }, [props.yo.tenantId, props.monday]);

  // El plan permite un solo conector, así que a lo sumo uno está activo.
  const conector = bitrix
    ? adaptadorBitrix(props.yo, bitrix)
    : props.monday
      ? adaptadorMonday(props.yo, props.monday)
      : null;

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
        <Salientes yo={props.yo} conector={conector} alCambiar={props.alCambiar} />
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
  conector: ConectorAdapter | null;
  alCambiar: () => void;
}) {
  const { yo, conector } = props;
  const [plantillas, setPlantillas] = useState<PlantillaSaliente[]>([]);
  const [editando, setEditando] = useState<PlantillaSaliente | null>(null);
  const [campos, setCampos] = useState<{ id: string; title: string }[]>([]);
  const [guardado, setGuardado] = useState(false);
  const [guardarError, setGuardarError] = useState<string | null>(null);
  const [envios, setEnvios] = useState<Message[]>([]);

  const instanceId = conector?.instanceId;
  const enEdicion = editando !== null;

  useEffect(() => {
    if (!conector) return;
    conector.cargarCampos().then(setCampos).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yo.tenantId, conector?.tipo]);

  // Refresca el listado (estado/última vez por plantilla) y los envíos.
  // Mientras se edita, NO recarga las plantillas: así el polling no pisa lo
  // que el usuario está escribiendo (el bug de sincronía a evitar).
  useEffect(() => {
    if (!conector) return;
    const cargar = () => {
      if (!enEdicion) conector.verPlantillas().then(setPlantillas).catch(() => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yo.tenantId, conector?.tipo, instanceId, enEdicion]);

  if (!conector) {
    return (
      <div className="vacio">
        <p>Primero conecta tu CRM.</p>
        <p className="consola__sub">
          Los mensajes salientes se disparan desde tu CRM (monday o Bitrix24);
          configúralo en Conexiones.
        </p>
      </div>
    );
  }

  const persistir = async (lista: PlantillaSaliente[]): Promise<boolean> => {
    setGuardarError(null);
    try {
      await conector.guardarPlantillas(lista);
      setPlantillas(lista);
      setGuardado(true);
      props.alCambiar();
      return true;
    } catch (err: any) {
      setGuardarError(err?.message ?? "No se pudo guardar la plantilla.");
      return false;
    }
  };

  const guardarUna = async (p: PlantillaSaliente) => {
    if (!p.nombre.trim()) {
      setGuardarError("Ponle un nombre a la plantilla.");
      return;
    }
    const existe = plantillas.some((x) => x.id === p.id);
    const lista = existe
      ? plantillas.map((x) => (x.id === p.id ? p : x))
      : [...plantillas, p];
    if (await persistir(lista)) setEditando(null);
  };

  const quitar = async (id: string) => {
    if (plantillas.length <= 1) {
      setGuardarError("Debe quedar al menos una plantilla.");
      return;
    }
    await persistir(plantillas.filter((x) => x.id !== id));
  };

  const nueva = () => {
    setGuardado(false);
    setGuardarError(null);
    setEditando({
      id: crypto.randomUUID().slice(0, 8),
      nombre: "",
      cuerpo: "",
    });
  };

  if (editando) {
    return (
      <PlantillaEditor
        plantilla={editando}
        campos={campos}
        // La plantilla por defecto conserva la URL corta ya configurada en el
        // CRM; las demás usan su URL propia por id.
        url={conector.urlWebhook(editando.id)}
        error={guardarError}
        alGuardar={guardarUna}
        alCancelar={() => {
          setGuardarError(null);
          setEditando(null);
        }}
      />
    );
  }

  return (
    <div className="panel">
      <p className="consola__sub">
        {conector.contexto} Cada plantilla tiene su propia dirección de webhook:
        apunta cada automatización de tu CRM a la plantilla que quieras que mande.
      </p>

      <div className="guardar-fila">
        <button className="boton boton--primario" onClick={nueva}>
          Nueva plantilla
        </button>
        {guardado && <span className="ok-guardado">Guardado ✓</span>}
        {guardarError && <span className="mensaje-error">{guardarError}</span>}
      </div>

      {plantillas.length === 0 ? (
        <div className="vacio">
          <p>Aún no tienes plantillas.</p>
          <p className="consola__sub">
            Crea la primera (recordatorio de pago, bienvenida, seguimiento…).
          </p>
        </div>
      ) : (
        <ul className="plantillas">
          {plantillas.map((p) => (
            <li key={p.id} className="plantilla-fila">
              <div className="plantilla-fila__info">
                <strong>{p.nombre || "(sin nombre)"}</strong>
                <span className="consola__sub">{estadoPlantilla(p)}</span>
                <span className="registro__cuerpo tenue">
                  {p.cuerpo || "(vacía)"}
                </span>
              </div>
              <div className="plantilla-fila__acciones">
                <button className="boton" onClick={() => { setGuardado(false); setGuardarError(null); setEditando({ ...p }); }}>
                  Editar
                </button>
                <button
                  className="boton boton--peligro"
                  onClick={() => quitar(p.id)}
                  disabled={plantillas.length <= 1}
                >
                  Quitar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

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

/** Texto de estado de una plantilla para el listado (última vez + resultado). */
function estadoPlantilla(p: PlantillaSaliente): string {
  if (!p.ultimoDisparoEn) return "Aún no se ha disparado";
  const cuando = fechaLegible(p.ultimoDisparoEn);
  if (p.ultimoResultado?.ok === true) return `Último disparo ${cuando} · enviado`;
  if (p.ultimoResultado?.ok === false) return `Último disparo ${cuando} · falló`;
  return `Último disparo ${cuando}`;
}

/** Editor de UNA plantilla: nombre, cuerpo con variables/emojis, vista previa y su webhook. */
function PlantillaEditor(props: {
  plantilla: PlantillaSaliente;
  campos: { id: string; title: string }[];
  url: string;
  error: string | null;
  alGuardar: (p: PlantillaSaliente) => void;
  alCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(props.plantilla.nombre);
  const [cuerpo, setCuerpo] = useState(props.plantilla.cuerpo);
  const [copiado, setCopiado] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const insertar = (texto: string) => {
    const el = areaRef.current;
    if (!el) {
      setCuerpo((c) => c + texto);
      return;
    }
    const ini = el.selectionStart ?? cuerpo.length;
    const fin = el.selectionEnd ?? cuerpo.length;
    setCuerpo(cuerpo.slice(0, ini) + texto + cuerpo.slice(fin));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = ini + texto.length;
    });
  };

  const preview = cuerpo.replace(
    /\{\{\s*([\w.-]+)\s*\}\}/g,
    (_m: string, k: string): string =>
      k === "nombre" ? EJEMPLO.nombre! : (EJEMPLO[k] ?? `[${k}]`),
  );

  return (
    <div className="panel">
      <label className="campo-etq">
        <span>Nombre de la plantilla</span>
        <input
          className="campo"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Recordatorio de pago"
        />
      </label>

      <label className="campo-etq">
        <span>Mensaje</span>
        <div className="editor">
          <div className="editor__barra">
            <span className="editor__grupo">
              {props.campos.length === 0 && (
                <span className="tenue">cargando campos…</span>
              )}
              {props.campos.map((c) => (
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
            value={cuerpo}
            onChange={(e) => setCuerpo(e.target.value)}
            placeholder="Hola {{nombre}}, tu saldo de {{saldo}} vence el {{fecha}}."
          />
        </div>
      </label>

      <div className="preview">
        <span className="preview__etq">Vista previa</span>
        <p className="preview__cuerpo">{preview || "…"}</p>
      </div>

      <div className="guardar-fila">
        <button
          className="boton boton--primario"
          onClick={() => props.alGuardar({ ...props.plantilla, nombre, cuerpo })}
        >
          Guardar plantilla
        </button>
        <button className="boton" onClick={props.alCancelar}>
          Cancelar
        </button>
        {props.error && <span className="mensaje-error">{props.error}</span>}
      </div>

      <div className="webhook">
        <h3>Dirección de webhook de esta plantilla</h3>
        <p className="consola__sub">
          Un <em>webhook</em> es un aviso automático: cuando se cumple una
          condición en tu board, monday le avisa a Cauce enviando el item a esta
          dirección. Pega <strong>esta</strong> dirección en la automatización de
          monday que deba mandar <strong>este</strong> mensaje.
        </p>
        <div className="fila-inline">
          <input className="campo webhook__url" readOnly value={props.url} />
          <button
            className="boton"
            onClick={() => {
              navigator.clipboard?.writeText(props.url).then(
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
        <p className="consola__sub tenue">
          En monday: <em>Integrar → Webhooks</em> (o{" "}
          <em>Automatizaciones → "Send a webhook"</em>), elige la condición
          (p. ej. la fecha de pago es hoy) y pega esta URL. Guárdala una vez por
          plantilla.
        </p>
      </div>
    </div>
  );
}

const ETIQUETA_ENVIO: Record<string, string> = {
  encolado: "Encolado",
  enviando: "Enviando",
  enviado: "Enviado",
  no_confirmado: "Sin confirmar",
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

  // Cualquier edición invalida la confirmación previa.
  const tocado = () => setGuardado(false);

  const actualizar = (id: string, cambios: Partial<Disparador>) => {
    tocado();
    setLista((l) => l.map((d) => (d.id === id ? { ...d, ...cambios } : d)));
  };

  const agregar = () => {
    tocado();
    const nuevo: Disparador = {
      id: crypto.randomUUID().slice(0, 8),
      prioridad: (lista.at(-1)?.prioridad ?? 0) + 10,
      tipo: "cualquiera",
      activo: true,
      respuesta: "",
    };
    setLista((l) => [...l, nuevo]);
  };

  const quitar = (id: string) => {
    tocado();
    setLista((l) => l.filter((d) => d.id !== id));
  };

  const mover = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= lista.length) return;
    tocado();
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
      setGuardado(true); // persistente hasta la próxima edición
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

      <div className="guardar-fila">
        <button className="boton" onClick={agregar}>
          Agregar acción
        </button>
        <button className="boton boton--primario" onClick={guardar}>
          Guardar acciones
        </button>
        {guardado && (
          <span className="ok-guardado">
            Acciones guardadas ✓ · se aplican a los mensajes que lleguen.
          </span>
        )}
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
