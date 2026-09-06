import { useEffect, useMemo, useState } from "react";
import type { InstanceEstado } from "@cauce/core";
import { crearSesionesDemo, TENANT_DEMO, type Sesion } from "./sesiones.ts";
import "./app.css";

const ETIQUETAS: Record<InstanceEstado, string> = {
  pending: "Iniciando",
  qr: "Esperando QR",
  connected: "Conectado",
  disconnected: "Desconectado",
};

interface Fila {
  sesion: Sesion;
  estado: InstanceEstado;
  qr: string | null;
}

export default function App() {
  const sesiones = useMemo(crearSesionesDemo, []);
  const [filas, setFilas] = useState<Fila[]>(() =>
    sesiones.map((sesion) => ({ sesion, estado: sesion.transporte.status(), qr: null })),
  );

  useEffect(() => {
    for (const s of sesiones) void s.transporte.connect();
    const intervalo = setInterval(async () => {
      const siguientes = await Promise.all(
        sesiones.map(async (sesion) => ({
          sesion,
          estado: sesion.transporte.status(),
          qr: await sesion.transporte.getQr(),
        })),
      );
      setFilas(siguientes);
    }, 400);
    return () => clearInterval(intervalo);
  }, [sesiones]);

  const alternar = (fila: Fila) => {
    if (fila.estado === "disconnected") void fila.sesion.transporte.connect();
    else void fila.sesion.transporte.disconnect();
  };

  const conectadas = filas.filter((f) => f.estado === "connected").length;

  return (
    <main className="consola">
      <header className="consola__cabecera">
        <h1>Cauce</h1>
        <p className="consola__sub">
          Instancias del tenant <strong>{TENANT_DEMO}</strong> ·{" "}
          {conectadas} de {filas.length} conectadas
        </p>
      </header>

      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Transporte</th>
            <th>Estado</th>
            <th>Último heartbeat</th>
            <th aria-label="acciones" />
          </tr>
        </thead>
        <tbody>
          {filas.map((fila) => (
            <tr key={fila.sesion.instancia.id}>
              <td className="celda-numero">{fila.sesion.instancia.numero}</td>
              <td className="celda-transporte">
                {fila.sesion.instancia.transportType}
              </td>
              <td>
                <span className={`estado estado--${fila.estado}`}>
                  {ETIQUETAS[fila.estado]}
                </span>
                {fila.qr && (
                  <span className="celda-qr" title={fila.qr}>
                    escanea para vincular
                  </span>
                )}
              </td>
              <td className="celda-heartbeat">
                {fila.estado === "connected"
                  ? new Date().toLocaleTimeString("es-MX")
                  : "—"}
              </td>
              <td className="celda-acciones">
                <button
                  className={
                    fila.estado === "disconnected"
                      ? "boton boton--primario"
                      : "boton"
                  }
                  onClick={() => alternar(fila)}
                >
                  {fila.estado === "disconnected" ? "Conectar" : "Desconectar"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
