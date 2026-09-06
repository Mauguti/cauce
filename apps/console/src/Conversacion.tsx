import { useCallback, useEffect, useRef, useState } from "react";
import type { Instance, Message, MessageEstado } from "@cauce/core";
import { api } from "./api.ts";

const GLIFO_ESTADO: Record<MessageEstado, string> = {
  encolado: "◌",
  enviando: "◌",
  enviado: "✓",
  fallido: "✗",
  recibido: "",
};

export function Conversacion(props: {
  tenantId: string;
  instanceId: string;
  alVolver: () => void;
}) {
  const { tenantId, instanceId } = props;
  const [instancia, setInstancia] = useState<Instance | null>(null);
  const [mensajes, setMensajes] = useState<Message[]>([]);
  const [telefono, setTelefono] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finRef = useRef<HTMLDivElement>(null);
  const cuantosRef = useRef(0);

  const refrescar = useCallback(async () => {
    try {
      const [inst, msgs] = await Promise.all([
        api.instancia(tenantId, instanceId),
        api.mensajes(tenantId, instanceId),
      ]);
      setInstancia(inst);
      setMensajes(msgs);
      setError(null);
    } catch {
      setError("Sin conexión con el orquestador.");
    }
  }, [tenantId, instanceId]);

  useEffect(() => {
    void refrescar();
    const intervalo = setInterval(refrescar, 2500);
    return () => clearInterval(intervalo);
  }, [refrescar]);

  useEffect(() => {
    if (mensajes.length > cuantosRef.current) {
      finRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    cuantosRef.current = mensajes.length;
  }, [mensajes.length]);

  // El último teléfono con el que se conversó, como default del campo.
  useEffect(() => {
    if (!telefono && mensajes.length > 0) {
      setTelefono(mensajes[mensajes.length - 1]!.telefono);
    }
  }, [mensajes, telefono]);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!telefono.trim() || !cuerpo.trim()) return;
    setError(null);
    try {
      await api.enviar(tenantId, instanceId, telefono.trim(), cuerpo.trim());
      setCuerpo("");
      await refrescar();
    } catch (err: any) {
      setError(err?.message ?? "No se pudo encolar el mensaje.");
    }
  };

  return (
    <main className="consola consola--conversacion">
      <header className="consola__cabecera consola__cabecera--fila">
        <div>
          <h1>{instancia?.numero ?? instanceId}</h1>
          <p className="consola__sub">
            {instancia && (
              <span className={`estado estado--${instancia.estado}`}>
                {instancia.estado === "connected"
                  ? "Conectada"
                  : instancia.estado === "qr"
                    ? "Esperando QR"
                    : instancia.estado === "pending"
                      ? "Iniciando"
                      : "Desconectada"}
              </span>
            )}
          </p>
        </div>
        <button className="boton" onClick={props.alVolver}>
          ← Sesiones
        </button>
      </header>

      <section className="hilo">
        {mensajes.map((m) => (
          <article
            key={m.id}
            className={`burbuja burbuja--${m.direccion} burbuja--${m.estado}`}
          >
            <p className="burbuja__cuerpo">{m.cuerpo}</p>
            <p className="burbuja__meta">
              {m.direccion === "in" ? `${m.telefono} · ` : ""}
              {new Date(m.timestamp).toLocaleTimeString("es-MX", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {m.direccion === "out" && (
                <span className="burbuja__estado" title={m.estado}>
                  {" "}
                  {GLIFO_ESTADO[m.estado]} {m.estado}
                </span>
              )}
            </p>
          </article>
        ))}
        {mensajes.length === 0 && (
          <p className="consola__sub">Sin mensajes todavía.</p>
        )}
        <div ref={finRef} />
      </section>

      {error && <p className="mensaje-error">{error}</p>}

      <form className="envio" onSubmit={enviar}>
        <input
          className="campo envio__telefono"
          placeholder="+5215512345678"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
        />
        <input
          className="campo envio__cuerpo"
          placeholder="Mensaje"
          value={cuerpo}
          onChange={(e) => setCuerpo(e.target.value)}
        />
        <button
          className="boton boton--primario"
          type="submit"
          disabled={instancia?.estado !== "connected"}
        >
          Enviar
        </button>
      </form>
    </main>
  );
}
