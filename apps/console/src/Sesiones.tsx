import { useCallback, useEffect, useRef, useState } from "react";
import type { Instance, InstanceEstado } from "@cauce/core";
import { api, type Yo } from "./api.ts";
import { Expectativas } from "./Expectativas.tsx";

const ETIQUETAS: Record<InstanceEstado, string> = {
  pending: "Iniciando",
  qr: "Esperando QR",
  connected: "Conectada",
  disconnected: "Desconectada",
};

export function Sesiones(props: {
  yo: Yo;
  alAbrir: (instanceId: string) => void;
  alCambiar: () => void;
}) {
  const { yo } = props;
  const [instancias, setInstancias] = useState<Instance[]>([]);
  const [creando, setCreando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Error de una ACCIÓN del usuario (crear/límite): el polling no lo pisa.
  const [accionError, setAccionError] = useState<string | null>(null);
  const [qrDe, setQrDe] = useState<string | null>(null);
  const [aEliminar, setAEliminar] = useState<Instance | null>(null);
  const [aDesconectar, setADesconectar] = useState<Instance | null>(null);
  const [aceptado, setAceptado] = useState(yo.terminosAceptados);
  const [mostrarExpectativas, setMostrarExpectativas] = useState(false);

  const refrescar = useCallback(async () => {
    try {
      setInstancias(await api.instancias(yo.tenantId));
      setError(null);
    } catch {
      setError("Sin conexión con Cauce. Reintentando…");
    }
  }, [yo.tenantId]);

  useEffect(() => {
    void refrescar();
    const intervalo = setInterval(refrescar, 3000);
    return () => clearInterval(intervalo);
  }, [refrescar]);

  // Contador de progreso mientras se prepara el número (~60s).
  useEffect(() => {
    if (!creando) return;
    setSegundos(0);
    const t = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [creando]);

  // Al pulsar "Conectar número": primero las expectativas (una vez).
  const onConectar = () => {
    if (aceptado) void crear();
    else setMostrarExpectativas(true);
  };

  const aceptarYConectar = async () => {
    await api.aceptarTerminos(yo.tenantId).catch(() => {});
    setAceptado(true);
    setMostrarExpectativas(false);
    props.alCambiar();
    void crear();
  };

  const crear = async () => {
    setCreando(true);
    setAccionError(null);
    try {
      const creada = await api.crearInstancia(yo.tenantId);
      await refrescar();
      props.alCambiar();
      setQrDe(creada.id);
    } catch (err: any) {
      // Mensaje del servidor (p. ej. límite de plan), persistente.
      setAccionError(err?.message ?? "No se pudo conectar el número. Intenta de nuevo.");
    } finally {
      setCreando(false);
    }
  };

  const desconectar = async (id: string) => {
    setADesconectar(null);
    await api.desconectarInstancia(yo.tenantId, id).catch(() => {});
    await refrescar();
    props.alCambiar();
  };

  const reconectar = async (id: string) => {
    await api.reconectarInstancia(yo.tenantId, id).catch(() => {});
    await refrescar();
    props.alCambiar();
    setQrDe(id);
  };

  const eliminar = async (id: string) => {
    setAEliminar(null);
    await api.eliminarInstancia(yo.tenantId, id).catch(() => {});
    await refrescar();
    props.alCambiar();
  };

  const conectadas = instancias.filter((i) => i.estado === "connected").length;

  return (
    <main className="seccion">
      <header className="seccion__cabecera seccion__cabecera--fila">
        <div>
          <h1>Sesiones</h1>
          <p className="consola__sub">
            {conectadas} de {instancias.length} conectadas
          </p>
        </div>
        <button
          className="boton boton--primario"
          onClick={onConectar}
          disabled={creando}
        >
          {creando ? "Preparando…" : "Conectar número"}
        </button>
      </header>

      {accionError && (
        <p className="mensaje-error">
          {accionError}{" "}
          <button className="mini-cerrar" onClick={() => setAccionError(null)} aria-label="Cerrar">
            ×
          </button>
        </p>
      )}
      {error && <p className="mensaje-error">{error}</p>}
      {creando && (
        <div className="preparando">
          <div className="barra">
            <div
              className="barra__relleno"
              style={{ width: `${Math.min((segundos / 60) * 100, 96)}%` }}
            />
          </div>
          <p className="consola__sub">
            Preparando tu número… suele tardar alrededor de un minuto ({segundos}s).
            En cuanto esté listo aparece el código QR para escanear.
          </p>
        </div>
      )}

      {instancias.length === 0 && !creando ? (
        <div className="vacio">
          <p>Aún no conectas ningún número.</p>
          <p className="consola__sub">
            Conecta el número desde el que enviarás y recibirás mensajes.
          </p>
        </div>
      ) : (
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
                <td className="celda-numero">
                  {inst.numero ?? <span className="tenue">Escanea el QR para vincular</span>}
                </td>
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
                  {inst.estado === "connected" && (
                    <button className="boton" onClick={() => props.alAbrir(inst.id)}>
                      Conversaciones
                    </button>
                  )}
                  {inst.estado === "disconnected" ? (
                    <button className="boton" onClick={() => reconectar(inst.id)}>
                      Reconectar
                    </button>
                  ) : (
                    <button className="boton" onClick={() => setADesconectar(inst)}>
                      Desconectar WhatsApp
                    </button>
                  )}
                  <button className="boton" onClick={() => setAEliminar(inst)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {qrDe && (
        <ModalQr
          tenantId={yo.tenantId}
          instanceId={qrDe}
          alCerrar={() => {
            setQrDe(null);
            void refrescar();
          }}
        />
      )}

      {aEliminar && (
        <div className="modal-fondo" onClick={() => setAEliminar(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Eliminar número</h2>
            <p>
              Se borra el número{" "}
              <strong>{aEliminar.numero ?? "sin conectar"}</strong> de Cauce y
              todo su historial.
            </p>
            <p className="mensaje-error">
              Se pierden las conversaciones y la conexión con el CRM. Esto no se
              puede deshacer. (Si solo quieres pausarlo, usa "Desconectar".)
            </p>
            <div className="modal__acciones">
              <button className="boton" onClick={() => setAEliminar(null)}>
                Cancelar
              </button>
              <button
                className="boton boton--primario"
                onClick={() => eliminar(aEliminar.id)}
              >
                Eliminar definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

      {aDesconectar && (
        <div className="modal-fondo" onClick={() => setADesconectar(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Desconectar WhatsApp</h2>
            <p>
              Cierra la sesión de WhatsApp de{" "}
              <strong>{aDesconectar.numero ?? "este número"}</strong>. Deja de
              enviar y recibir hasta que lo reconectes escaneando el QR de nuevo.
            </p>
            <p className="consola__sub">
              Tus conversaciones y la conexión con el CRM se conservan. No borra
              nada; es reversible.
            </p>
            <div className="modal__acciones">
              <button className="boton" onClick={() => setADesconectar(null)}>
                Cancelar
              </button>
              <button
                className="boton boton--primario"
                onClick={() => desconectar(aDesconectar.id)}
              >
                Desconectar WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

      {mostrarExpectativas && (
        <Expectativas
          alAceptar={aceptarYConectar}
          alCancelar={() => setMostrarExpectativas(false)}
        />
      )}
    </main>
  );
}

/**
 * QR de vinculación: se pide fresco cada 3s (se regenera cada ~20s) y
 * nunca se cachea. Al conectar, el modal lo anuncia y se cierra solo.
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
              WhatsApp → Dispositivos vinculados → Vincular dispositivo. El
              código se renueva solo.
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
