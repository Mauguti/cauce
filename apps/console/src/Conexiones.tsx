import { useEffect, useState } from "react";
import type { Instance } from "@cauce/core";
import {
  api,
  columnaEsTelefono,
  ENTIDADES_BITRIX,
  type Yo,
  type MondayBoard,
  type MondayColumna,
  type MondayVista,
  type BitrixVista,
  type CampoBitrix,
  type EntidadBitrix,
} from "./api.ts";

/**
 * Catálogo de CRMs conectables. Hoy solo monday; agregar Bitrix o
 * Pipedrive es añadir una entrada y su asistente, no rediseñar.
 */
const CRMS = [
  { id: "monday", nombre: "monday", disponible: true },
  { id: "bitrix", nombre: "Bitrix24", disponible: true },
  { id: "pipedrive", nombre: "Pipedrive", disponible: false },
];

export function Conexiones(props: {
  yo: Yo;
  instancias: Instance[];
  alCambiar: () => void;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);

  return (
    <main className="seccion">
      <header className="seccion__cabecera">
        <h1>Conexiones</h1>
        <p className="consola__sub">Conecta las herramientas que ya usas.</p>
      </header>

      <div className="conexiones">
        {CRMS.map((crm) => (
          <div key={crm.id} className="conexion">
            <div className="conexion__info">
              <h2>{crm.nombre}</h2>
              {!crm.disponible && (
                <span className="tenue">Próximamente</span>
              )}
            </div>
            {crm.disponible ? (
              <button
                className="boton"
                onClick={() => setAbierto(abierto === crm.id ? null : crm.id)}
              >
                {abierto === crm.id ? "Cerrar" : "Configurar"}
              </button>
            ) : (
              <button className="boton" disabled>
                Configurar
              </button>
            )}
          </div>
        ))}
      </div>

      {abierto === "monday" && (
        <AsistenteMonday
          yo={props.yo}
          instancias={props.instancias}
          alGuardar={props.alCambiar}
        />
      )}
      {abierto === "bitrix" && (
        <AsistenteBitrix
          yo={props.yo}
          instancias={props.instancias}
          alGuardar={props.alCambiar}
        />
      )}
    </main>
  );
}


function AsistenteMonday(props: {
  yo: Yo;
  instancias: Instance[];
  alGuardar: () => void;
}) {
  const { yo } = props;
  const [existente, setExistente] = useState<MondayVista | null>(null);
  const [apiToken, setApiToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [boards, setBoards] = useState<MondayBoard[] | null>(null);
  const [boardId, setBoardId] = useState("");
  const [boardNombre, setBoardNombre] = useState("");
  const [columnas, setColumnas] = useState<MondayColumna[]>([]);
  const [columnaTelefono, setColumnaTelefono] = useState("");
  const [estado, setEstado] = useState<
    { tipo: "ok" | "error" | "info"; texto: string } | null
  >(null);
  const [guardado, setGuardado] = useState(false);
  const [confirmarQuitar, setConfirmarQuitar] = useState(false);
  // Colapsado: con conexión existente se muestra un resumen, no el form.
  const [editando, setEditando] = useState(false);

  const conectadas = props.instancias.filter((i) => i.estado === "connected");

  // Al abrir con conexión existente: recupera board y columna, y recarga
  // las columnas del board con el token guardado (server-side), para que
  // el selector de columna no quede vacío al editar.
  useEffect(() => {
    api.monday.ver(yo.tenantId).then((v) => {
      setExistente(v);
      if (v) {
        setInstanceId(v.instanceId);
        setBoardId(v.boardId);
        setBoardNombre(v.boardNombre);
        setColumnaTelefono(v.columnaTelefono);
        setEditando(false);
        api.monday
          .columnasGuardadas(yo.tenantId)
          .then(setColumnas)
          .catch(() =>
            setEstado({
              tipo: "error",
              texto:
                "No se pudieron recargar las columnas del board guardado; vuelve a probar el token.",
            }),
          );
      } else {
        setEditando(true);
      }
    });
  }, [yo.tenantId]);

  const probar = async () => {
    setEstado({ tipo: "info", texto: "Consultando monday…" });
    setBoards(null);
    try {
      const r = await api.monday.probar(yo.tenantId, apiToken);
      setBoards(r.boards);
      setEstado({
        tipo: "ok",
        texto: `Conexión correcta · ${r.boards.length} boards encontrados.`,
      });
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "monday rechazó el token." });
    }
  };

  const elegirBoard = async (id: string) => {
    setBoardId(id);
    setBoardNombre(boards?.find((b) => b.id === id)?.name ?? "");
    setColumnas([]);
    setColumnaTelefono("");
    if (!id) return;
    try {
      setColumnas(await api.monday.columnas(yo.tenantId, apiToken, id));
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudieron leer las columnas." });
    }
  };

  // Solo columnas donde tiene sentido buscar un teléfono.
  const columnasTelefono = columnas.filter((c) => columnaEsTelefono(c.type));

  const guardar = async () => {
    setEstado({ tipo: "info", texto: "Guardando…" });
    try {
      await api.monday.guardar(yo.tenantId, {
        instanceId,
        boardId,
        boardNombre,
        // Vacío al editar = conserva el token guardado.
        apiToken,
        signingSecret,
        columnaTelefono,
        // Las plantillas se gestionan en Acciones → Salientes, no aquí.
      });
      setGuardado(true);
      setEstado({ tipo: "ok", texto: "Conexión guardada." });
      // Refresca la vista y colapsa a resumen (estado configurado).
      const v = await api.monday.ver(yo.tenantId);
      setExistente(v);
      setEditando(false);
      props.alGuardar();
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudo guardar." });
    }
  };

  const quitar = async () => {
    setConfirmarQuitar(false);
    try {
      await api.monday.quitar(yo.tenantId);
      setExistente(null);
      setApiToken("");
      setSigningSecret("");
      setBoards(null);
      setBoardId("");
      setColumnas([]);
      setColumnaTelefono("");
      setGuardado(false);
      setEditando(true);
      setEstado({ tipo: "ok", texto: "Conexión quitada." });
      props.alGuardar();
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudo quitar." });
    }
  };

  // Al editar (ya hay conexión) no hace falta repegar el token.
  const puedeGuardar =
    (apiToken || existente) && instanceId && boardId && columnaTelefono;

  const hayColumnasTelefono = columnas.length === 0 || columnasTelefono.length > 0;

  // Vista colapsada: conexión configurada, sin formulario.
  if (existente && !editando) {
    return (
      <section className="asistente">
        <div className="config-ok">
          <div>
            <h2>monday conectado ✓</h2>
            <p className="consola__sub">
              Board <strong>{existente.boardNombre || existente.boardId}</strong> ·
              columna de teléfono <strong>{existente.columnaTelefono}</strong> ·
              token {existente.apiTokenPista}
            </p>
            {guardado && <p className="ok-guardado">Cambios guardados.</p>}
          </div>
          <div className="config-ok__acciones">
            <button className="boton" onClick={() => { setGuardado(false); setEstado(null); setEditando(true); }}>
              Editar
            </button>
            <button className="boton" onClick={() => setConfirmarQuitar(true)}>
              Quitar
            </button>
          </div>
        </div>
        {confirmarQuitar && modalQuitar()}
      </section>
    );
  }

  return (
    <section className="asistente">
      <h2>Conectar monday</h2>

      {existente && (
        <p className="consola__sub">
          Conectado al board <strong>{existente.boardNombre || existente.boardId}</strong>{" "}
          (token {existente.apiTokenPista}). Puedes editar sin repegar el token;
          para cambiar de cuenta, pega un token nuevo y prueba.
        </p>
      )}

      <details className="ayuda">
        <summary>¿Dónde saco el token y el signing secret?</summary>
        <ol>
          <li>
            <strong>API token:</strong> en monday, haz clic en tu avatar
            (abajo a la izquierda) → <em>Developers</em>. En{" "}
            <em>My Access Tokens</em> copia tu token personal, o crea uno.
          </li>
          <li>
            <strong>Signing Secret:</strong> solo si usarás disparos salientes
            firmados. En <em>Developers</em> → tu app → <em>Basic
            Information</em>, copia el <em>Signing Secret</em>. Si aún no tienes
            una app de monday, puedes dejarlo vacío por ahora.
          </li>
        </ol>
      </details>

      <label className="campo-etq">
        <span>Número desde el que se envía</span>
        <select
          className="campo"
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
        >
          <option value="">Elige una sesión conectada…</option>
          {conectadas.map((i) => (
            <option key={i.id} value={i.id}>
              {i.numero ?? i.id}
            </option>
          ))}
        </select>
      </label>

      <label className="campo-etq">
        <span>API token de monday</span>
        <div className="fila-inline">
          <input
            className="campo"
            type="password"
            value={apiToken}
            placeholder={existente ? "•••••• (deja vacío para conservar)" : "Pega tu token"}
            onChange={(e) => setApiToken(e.target.value)}
          />
          <button className="boton" onClick={probar} disabled={!apiToken}>
            Probar conexión
          </button>
        </div>
      </label>

      <label className="campo-etq">
        <span>Signing Secret (opcional)</span>
        <input
          className="campo"
          type="password"
          value={signingSecret}
          placeholder={existente?.tieneSigningSecret ? "•••••• (configurado; vacío conserva)" : "Opcional"}
          onChange={(e) => setSigningSecret(e.target.value)}
        />
      </label>

      {estado && (
        <p className={estado.tipo === "error" ? "mensaje-error" : "consola__sub"}>
          {estado.texto}
        </p>
      )}

      {boards && (
        <label className="campo-etq">
          <span>Board</span>
          <select
            className="campo"
            value={boardId}
            onChange={(e) => elegirBoard(e.target.value)}
          >
            <option value="">Elige un board…</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {columnas.length > 0 && (
        <label className="campo-etq">
          <span>Columna del teléfono</span>
          {hayColumnasTelefono ? (
            <select
              className="campo"
              value={columnaTelefono}
              onChange={(e) => setColumnaTelefono(e.target.value)}
            >
              <option value="">Elige la columna…</option>
              {columnasTelefono.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.type})
                </option>
              ))}
            </select>
          ) : (
            <p className="mensaje-error">
              Este board no tiene columnas de tipo teléfono ni texto. Agrega una
              en monday para poder mapear el número.
            </p>
          )}
        </label>
      )}

      <div className="fila-inline">
        <button
          className="boton boton--primario"
          onClick={guardar}
          disabled={!puedeGuardar}
        >
          Guardar conexión
        </button>
        {existente && (
          <button className="boton" onClick={() => setConfirmarQuitar(true)}>
            Quitar conexión
          </button>
        )}
      </div>

      {confirmarQuitar && modalQuitar()}
    </section>
  );

  function modalQuitar() {
    return (
      <div className="modal-fondo" onClick={() => setConfirmarQuitar(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>Quitar conexión con monday</h2>
          <p>
            Se borran el API token y el signing secret guardados (cifrados).
          </p>
          <p className="mensaje-error">
            El <strong>disparo saliente desde monday</strong> quedará inactivo:
            los eventos del board dejarán de enviar mensajes hasta que
            reconectes. Los disparadores de entrada no se ven afectados.
          </p>
          <div className="modal__acciones">
            <button className="boton" onClick={() => setConfirmarQuitar(false)}>
              Cancelar
            </button>
            <button className="boton boton--primario" onClick={quitar}>
              Quitar conexión
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Alta autoservicio de Bitrix24: el cliente pega la URL de su webhook
 * ENTRANTE (con el token), elige la entidad y mapea el campo del teléfono
 * — el mismo flujo que monday. El application_token del webhook SALIENTE
 * es opcional (verifica los disparos). Nada se guarda en claro.
 */
function AsistenteBitrix(props: {
  yo: Yo;
  instancias: Instance[];
  alGuardar: () => void;
}) {
  const { yo } = props;
  const [existente, setExistente] = useState<BitrixVista | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [applicationToken, setApplicationToken] = useState("");
  const [entidad, setEntidad] = useState<EntidadBitrix>("deal");
  const [campos, setCampos] = useState<CampoBitrix[]>([]);
  const [campoTelefono, setCampoTelefono] = useState("");
  const [estado, setEstado] = useState<{ tipo: "info" | "ok" | "error"; texto: string } | null>(null);
  const [editando, setEditando] = useState(false);
  const [guardado, setGuardado] = useState(false);
  const [confirmarQuitar, setConfirmarQuitar] = useState(false);

  const conectadas = props.instancias.filter((i) => i.estado === "connected");

  useEffect(() => {
    api.bitrix.ver(yo.tenantId).then((v) => {
      setExistente(v);
      if (v) {
        setInstanceId(v.instanceId);
        setEntidad(v.entidad);
        setCampoTelefono(v.campoTelefono);
        setEditando(false);
        api.bitrix.camposGuardados(yo.tenantId).then(setCampos).catch(() => {});
      } else {
        setEditando(true);
      }
    });
  }, [yo.tenantId]);

  const probar = async () => {
    setEstado({ tipo: "info", texto: "Validando el webhook y leyendo campos…" });
    setCampos([]);
    try {
      await api.bitrix.probar(yo.tenantId, webhookUrl);
      const c = await api.bitrix.campos(yo.tenantId, webhookUrl, entidad);
      setCampos(c);
      // Sugiere el campo estándar de teléfono si existe.
      const tel = c.find((x) => x.id === "PHONE") ?? c.find((x) => /phone|tel/i.test(x.id));
      if (tel && !campoTelefono) setCampoTelefono(tel.id);
      setEstado({ tipo: "ok", texto: `Webhook válido · ${c.length} campos en ${entidad}.` });
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "Bitrix rechazó el webhook." });
    }
  };

  const guardar = async () => {
    if (!instanceId) return setEstado({ tipo: "error", texto: "Elige el número desde el que se envía." });
    if (!campoTelefono) return setEstado({ tipo: "error", texto: "Mapea qué campo tiene el teléfono." });
    setEstado({ tipo: "info", texto: "Guardando…" });
    try {
      await api.bitrix.guardar(yo.tenantId, {
        instanceId,
        entidad,
        campoTelefono,
        webhookUrl, // vacío al editar = conserva el guardado
        applicationToken,
      });
      setGuardado(true);
      setEstado({ tipo: "ok", texto: "Conexión guardada." });
      const v = await api.bitrix.ver(yo.tenantId);
      setExistente(v);
      setEditando(false);
      props.alGuardar();
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudo guardar." });
    }
  };

  const quitar = async () => {
    await api.bitrix.quitar(yo.tenantId).catch(() => {});
    setExistente(null);
    setConfirmarQuitar(false);
    setEditando(true);
    setCampos([]);
    props.alGuardar();
  };

  if (existente && !editando) {
    return (
      <section className="asistente">
        <div className="config-ok">
          <div>
            <h2>Bitrix24 conectado</h2>
            <p className="consola__sub">
              Entidad <strong>{existente.entidad}</strong> · teléfono en{" "}
              <strong>{existente.campoTelefono}</strong> · webhook{" "}
              <strong>{existente.webhookPista}</strong>
              {existente.tieneApplicationToken ? " · disparos verificados" : ""}
            </p>
          </div>
          <div className="config-ok__acciones">
            <button className="boton" onClick={() => setEditando(true)}>Editar</button>
            <button className="boton boton--peligro" onClick={() => setConfirmarQuitar(true)}>
              Quitar
            </button>
          </div>
        </div>
        {confirmarQuitar && (
          <p className="mensaje-error">
            ¿Quitar la conexión con Bitrix? Los disparos salientes dejan de funcionar.{" "}
            <button className="boton mini-link" onClick={quitar}>Sí, quitar</button>{" "}
            <button className="boton mini-link" onClick={() => setConfirmarQuitar(false)}>Cancelar</button>
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="asistente">
      <h2>Conectar Bitrix24</h2>

      <details className="ayuda">
        <summary>¿Dónde saco la URL del webhook y el token?</summary>
        <ol>
          <li>
            En Bitrix: <em>Aplicaciones → Desarrolladores → Otro → Webhook
            entrante</em>. Marca los permisos de <strong>CRM</strong> y copia la
            URL (termina en <code>/rest/…/…/</code>). Es como una contraseña:
            quien la tenga puede entrar a tu CRM.
          </li>
          <li>
            Para el disparo: crea un <em>Webhook saliente</em> (o una regla de
            automatización que llame un webhook) apuntando a la URL que te
            damos abajo por plantilla, y copia su <strong>application token</strong>{" "}
            aquí para que Digsol Factory verifique que el disparo es tuyo (opcional).
          </li>
        </ol>
      </details>

      <label className="campo-etq">
        <span>Número desde el que se envía</span>
        <select className="campo" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
          <option value="">Elige una sesión conectada…</option>
          {conectadas.map((i) => (
            <option key={i.id} value={i.id}>{i.numero ?? i.id}</option>
          ))}
        </select>
      </label>

      <label className="campo-etq">
        <span>URL del webhook entrante {existente ? "(vacío = conservar)" : ""}</span>
        <input
          className="campo"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://tu-portal.bitrix24.mx/rest/1/xxxxxxxx/"
        />
      </label>

      <label className="campo-etq">
        <span>Entidad que dispara</span>
        <select className="campo" value={entidad} onChange={(e) => { setEntidad(e.target.value as EntidadBitrix); setCampos([]); }}>
          {ENTIDADES_BITRIX.map((x) => (
            <option key={x.id} value={x.id}>{x.nombre}</option>
          ))}
        </select>
      </label>

      <div className="fila-inline">
        <button className="boton" onClick={probar} disabled={!webhookUrl}>
          Probar y leer campos
        </button>
      </div>

      {campos.length > 0 && (
        <label className="campo-etq">
          <span>¿Qué campo tiene el teléfono?</span>
          <select className="campo" value={campoTelefono} onChange={(e) => setCampoTelefono(e.target.value)}>
            <option value="">Elige un campo…</option>
            {campos.map((c) => (
              <option key={c.id} value={c.id}>{c.title} ({c.id})</option>
            ))}
          </select>
        </label>
      )}

      <label className="campo-etq">
        <span>Application token del webhook saliente (opcional)</span>
        <input
          className="campo"
          value={applicationToken}
          onChange={(e) => setApplicationToken(e.target.value)}
          placeholder="verifica que los disparos vengan de tu Bitrix"
        />
      </label>

      {estado && (
        <p className={estado.tipo === "error" ? "mensaje-error" : "consola__sub"}>{estado.texto}</p>
      )}

      <div className="guardar-fila">
        <button className="boton boton--primario" onClick={guardar}>Guardar conexión</button>
        {guardado && <span className="ok-guardado">Guardado ✓</span>}
      </div>
    </section>
  );
}
