import { useCallback, useEffect, useRef, useState } from "react";
import type { Instance, InstanceEstado } from "@cauce/core";
import { api, type Yo } from "./api.ts";

const ETIQUETAS: Record<InstanceEstado, string> = {
  pending: "Iniciando",
  qr: "Esperando QR",
  connected: "Conectada",
  disconnected: "Desconectada",
};

export function Sesiones(props: {
  yo: Yo;
  alAbrir: (instanceId: string) => void;
  alSalir: () => void;
}) {
  const { yo } = props;
  const [instancias, setInstancias] = useState<Instance[]>([]);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrDe, setQrDe] = useState<string | null>(null);

  const refrescar = useCallback(async () => {
    try {
      setInstancias(await api.instancias(yo.tenantId));
      setError(null);
    } catch {
      setError("Sin conexión con el orquestador.");
    }
  }, [yo.tenantId]);

  useEffect(() => {
    void refrescar();
    const intervalo = setInterval(refrescar, 3000);
    return () => clearInterval(intervalo);
  }, [refrescar]);

  const crear = async () => {
    setCreando(true);
    setError(null);
    try {
      const creada = await api.crearInstancia(yo.tenantId);
      await refrescar();
      setQrDe(creada.id);
    } catch (err: any) {
      setError(err?.message ?? "No se pudo crear la sesión.");
    } finally {
      setCreando(false);
    }
  };

  const conectadas = instancias.filter((i) => i.estado === "connected").length;

  return (
    <main className="consola">
      <header className="consola__cabecera consola__cabecera--fila">
        <div>
          <h1>Cauce</h1>
          <p className="consola__sub">
            {yo.nombre} · {conectadas} de {instancias.length} conectadas
          </p>
        </div>
        <div className="consola__acciones">
          <button
            className="boton boton--primario"
            onClick={crear}
            disabled={creando}
          >
            {creando ? "Creando sesión…" : "Conectar número"}
          </button>
          <button className="boton" onClick={props.alSalir}>
            Salir
          </button>
        </div>
      </header>

      {error && <p className="mensaje-error">{error}</p>}
      {creando && (
        <p className="consola__sub">
          Levantando contenedor e instancia; esto toma alrededor de un minuto.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Estado</th>
            <th>Último heartbeat</th>
            <th aria-label="acciones" />
          </tr>
        </thead>
        <tbody>
          {instancias.map((inst) => (
            <tr key={inst.id}>
              <td className="celda-numero">{inst.numero ?? inst.id}</td>
              <td>
                <span className={`estado estado--${inst.estado}`}>
                  {ETIQUETAS[inst.estado]}
                </span>
              </td>
              <td className="celda-heartbeat">
                {inst.ultimoHeartbeat
                  ? new Date(inst.ultimoHeartbeat).toLocaleTimeString("es-MX")
                  : "—"}
              </td>
              <td className="celda-acciones">
                {inst.estado === "qr" && (
                  <button className="boton" onClick={() => setQrDe(inst.id)}>
                    Ver QR
                  </button>
                )}
                <button className="boton" onClick={() => props.alAbrir(inst.id)}>
                  Conversación
                </button>
              </td>
            </tr>
          ))}
          {instancias.length === 0 && (
            <tr>
              <td colSpan={4} className="celda-vacia">
                Sin sesiones. Conecta tu primer número.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {qrDe && (
        <ModalQr
          tenantId={yo.tenantId}
          instanceId={qrDe}
          alCerrar={() => setQrDe(null)}
        />
      )}
    </main>
  );
}

/**
 * El QR de la sesión se regenera cada ~20 s: se pide fresco cada 3 s y
 * jamás se cachea. Cuando la sesión conecta, el modal lo anuncia y
 * se cierra solo.
 */
function ModalQr(props: {
  tenantId: string;
  instanceId: string;
  alCerrar: () => void;
}) {
  const [imagen, setImagen] = useState<string | null>(null);
  const [conectada, setConectada] = useState(false);
  const cerrar = useRef(props.alCerrar);
  cerrar.current = props.alCerrar;

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      const [qr, inst] = await Promise.all([
        api.qr(props.tenantId, props.instanceId).catch(() => null),
        api.instancia(props.tenantId, props.instanceId).catch(() => null),
      ]);
      if (!vivo) return;
      if (inst?.estado === "connected") {
        setConectada(true);
        setTimeout(() => cerrar.current(), 1500);
        return;
      }
      if (qr?.imagenBase64) setImagen(qr.imagenBase64);
    };
    void tick();
    const intervalo = setInterval(tick, 3000);
    return () => {
      vivo = false;
      clearInterval(intervalo);
    };
  }, [props.tenantId, props.instanceId]);

  return (
    <div className="modal-fondo" onClick={props.alCerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Vincular número</h2>
        {conectada ? (
          <p className="modal__estado">
            <span className="estado estado--connected">Conectada</span>
          </p>
        ) : imagen ? (
          <>
            <img className="modal__qr" src={imagen} alt="QR para vincular" />
            <p className="consola__sub">
              WhatsApp → Dispositivos vinculados → Vincular dispositivo.
              El código se renueva solo.
            </p>
          </>
        ) : (
          <p className="consola__sub">Generando QR…</p>
        )}
        <button className="boton" onClick={props.alCerrar}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
