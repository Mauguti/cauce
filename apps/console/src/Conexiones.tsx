import { useEffect, useState } from "react";
import type { Instance } from "@cauce/core";
import {
  api,
  type Yo,
  type MondayBoard,
  type MondayColumna,
  type MondayVista,
} from "./api.ts";

/**
 * Catálogo de CRMs conectables. Hoy solo monday; agregar Bitrix o
 * Pipedrive es añadir una entrada y su asistente, no rediseñar.
 */
const CRMS = [
  { id: "monday", nombre: "monday", disponible: true },
  { id: "bitrix", nombre: "Bitrix24", disponible: false },
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
    </main>
  );
}

const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

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
  const [columnas, setColumnas] = useState<MondayColumna[]>([]);
  const [columnaTelefono, setColumnaTelefono] = useState("");
  const [estado, setEstado] = useState<
    { tipo: "ok" | "error" | "info"; texto: string } | null
  >(null);
  const [guardado, setGuardado] = useState(false);

  const conectadas = props.instancias.filter((i) => i.estado === "connected");

  useEffect(() => {
    api.monday.ver(yo.tenantId).then((v) => {
      setExistente(v);
      if (v) {
        setInstanceId(v.instanceId);
        setBoardId(v.boardId);
        setColumnaTelefono(v.columnaTelefono);
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
    setColumnas([]);
    setColumnaTelefono("");
    try {
      setColumnas(await api.monday.columnas(yo.tenantId, apiToken, id));
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudieron leer las columnas." });
    }
  };

  const guardar = async () => {
    try {
      await api.monday.guardar(yo.tenantId, {
        instanceId,
        boardId,
        apiToken,
        signingSecret,
        columnaTelefono,
        // La plantilla se edita en Acciones; al dar de alta se deja vacía
        // si no había una previa.
        plantilla: existente?.plantilla ?? "",
      });
      setGuardado(true);
      setEstado({ tipo: "ok", texto: "Conexión guardada." });
      props.alGuardar();
    } catch (err: any) {
      setEstado({ tipo: "error", texto: err?.message ?? "No se pudo guardar." });
    }
  };

  const puedeGuardar = apiToken && instanceId && boardId && columnaTelefono;

  return (
    <section className="asistente">
      <h2>Conectar monday</h2>

      {existente && !guardado && (
        <p className="consola__sub">
          Ya hay una conexión (token {existente.apiTokenPista}). Pega el token
          de nuevo para reconfigurar; por seguridad no se muestra.
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
            placeholder={existente ? "•••••• (pega de nuevo)" : "Pega tu token"}
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
          placeholder={existente?.tieneSigningSecret ? "•••••• (configurado)" : "Opcional"}
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
          <select
            className="campo"
            value={columnaTelefono}
            onChange={(e) => setColumnaTelefono(e.target.value)}
          >
            <option value="">Elige la columna…</option>
            {columnas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({c.type})
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        className="boton boton--primario"
        onClick={guardar}
        disabled={!puedeGuardar}
      >
        Guardar conexión
      </button>
    </section>
  );
}

export { DIAS };
