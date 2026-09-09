import { useState } from "react";

/**
 * Pantallas que el usuario pasa ANTES de conectar su primer número.
 * Fijan expectativas del modelo: sesión no oficial, reconexión normal,
 * ritmo a propósito, y — con aceptación explícita — nada de prospección
 * en frío. Se muestran una sola vez (la aceptación se guarda en el tenant).
 */
export function Expectativas(props: {
  alAceptar: () => Promise<void> | void;
  alCancelar: () => void;
}) {
  const [paso, setPaso] = useState(0);
  const [acepto, setAcepto] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const pantallas = [
    {
      titulo: "Cómo se conecta tu número",
      cuerpo: (
        <>
          <p>
            Digsol Factory vincula tu WhatsApp como un <strong>dispositivo más</strong>,
            igual que WhatsApp Web: escaneas un QR desde tu teléfono y listo.
          </p>
          <p className="consola__sub">
            No es la API oficial de Meta ni un número nuevo — es tu mismo número
            de siempre, el que tus clientes ya tienen guardado.
          </p>
        </>
      ),
    },
    {
      titulo: "Se puede desconectar, y es normal",
      cuerpo: (
        <>
          <p>
            De vez en cuando la sesión se cae (WhatsApp la cierra, se reinicia el
            teléfono, etc.). Cuando pase, <strong>solo vuelves a escanear el QR</strong>{" "}
            desde Sesiones y sigues.
          </p>
          <p className="consola__sub">
            Mientras esté desconectada no se envían mensajes; te avisamos en el
            tablero.
          </p>
        </>
      ),
    },
    {
      titulo: "Los mensajes salen espaciados, a propósito",
      cuerpo: (
        <>
          <p>
            Digsol Factory deja pasar <strong>45 a 65 segundos entre cada envío</strong>. No
            es lento por error: mandar muchos mensajes de golpe es la forma más
            rápida de que WhatsApp bloquee tu número.
          </p>
          <p className="consola__sub">
            Para cobranza esto es de sobra; los recordatorios no son urgentes al
            segundo.
          </p>
        </>
      ),
    },
    {
      titulo: "Esto es para clientes, no para prospección en frío",
      cuerpo: (
        <>
          <p>
            Digsol Factory está pensado para escribirle a personas que{" "}
            <strong>ya son tus clientes</strong> y esperan tu mensaje (cobranza,
            recordatorios, seguimiento).
          </p>
          <p className="mensaje-error">
            Mandar mensajes a números fríos que no te conocen hace que te reporten
            y bloqueen el número. Eso no lo cubre ninguna herramienta.
          </p>
          <label className="check acepto">
            <input
              type="checkbox"
              checked={acepto}
              onChange={(e) => setAcepto(e.target.checked)}
            />
            Entiendo y usaré este número solo con mis clientes, no para
            prospección en frío.
          </label>
        </>
      ),
    },
  ];

  const esUltima = paso === pantallas.length - 1;
  const p = pantallas[paso]!;

  const continuar = async () => {
    if (!esUltima) {
      setPaso(paso + 1);
      return;
    }
    setGuardando(true);
    try {
      await props.alAceptar();
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="modal-fondo" onClick={props.alCancelar}>
      <div className="modal modal--ancho" onClick={(e) => e.stopPropagation()}>
        <div className="pasos-punto">
          {pantallas.map((_, i) => (
            <span key={i} className={`punto${i <= paso ? " punto--on" : ""}`} />
          ))}
        </div>
        <h2>{p.titulo}</h2>
        <div className="expectativa">{p.cuerpo}</div>
        <div className="modal__acciones">
          {paso > 0 ? (
            <button className="boton" onClick={() => setPaso(paso - 1)}>
              Atrás
            </button>
          ) : (
            <button className="boton" onClick={props.alCancelar}>
              Cancelar
            </button>
          )}
          <button
            className="boton boton--primario"
            onClick={continuar}
            disabled={(esUltima && !acepto) || guardando}
          >
            {esUltima
              ? guardando
                ? "Un momento…"
                : "Aceptar y conectar"
              : "Siguiente"}
          </button>
        </div>
      </div>
    </div>
  );
}
