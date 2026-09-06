type Seccion = "inicio" | "sesiones" | "conexiones" | "acciones";

/**
 * Estado vacío y primeros pasos. Un tenant nuevo ve qué hacer y en qué
 * orden, con el progreso marcado. La jerarquía es peso y estado (hecho /
 * pendiente), sin color, como el resto del sistema.
 */
export function PrimerosPasos(props: {
  hayNumeroConectado: boolean;
  hayConexion: boolean;
  hayAcciones: boolean;
  irA: (s: Seccion) => void;
}) {
  const pasos = [
    {
      n: 1,
      hecho: props.hayNumeroConectado,
      titulo: "Conecta tu número",
      texto:
        "Escanea el QR desde WhatsApp para vincular el número desde el que enviarás y recibirás.",
      accion: "Ir a Sesiones",
      seccion: "sesiones" as Seccion,
    },
    {
      n: 2,
      hecho: props.hayConexion,
      titulo: "Conecta tu CRM",
      texto:
        "Enlaza tu cuenta de monday: pega tu token, elige el board y mapea la columna del teléfono.",
      accion: "Ir a Conexiones",
      seccion: "conexiones" as Seccion,
    },
    {
      n: 3,
      hecho: props.hayAcciones,
      titulo: "Crea tu primera acción",
      texto:
        "Define qué dispara un mensaje saliente desde monday, o qué responder a los mensajes que llegan.",
      accion: "Ir a Acciones",
      seccion: "acciones" as Seccion,
    },
  ];
  const completados = pasos.filter((p) => p.hecho).length;

  return (
    <main className="seccion">
      <header className="seccion__cabecera">
        <h1>Primeros pasos</h1>
        <p className="consola__sub">
          {completados === pasos.length
            ? "Todo listo. Tu cuenta está operando."
            : `${completados} de ${pasos.length} completados`}
        </p>
      </header>

      <ol className="pasos">
        {pasos.map((p) => (
          <li
            key={p.n}
            className={`paso${p.hecho ? " paso--hecho" : ""}`}
          >
            <span className="paso__marca" aria-hidden>
              {p.hecho ? "●" : p.n}
            </span>
            <div className="paso__cuerpo">
              <h2>{p.titulo}</h2>
              <p>{p.texto}</p>
            </div>
            <button
              className={p.hecho ? "boton" : "boton boton--primario"}
              onClick={() => props.irA(p.seccion)}
            >
              {p.hecho ? "Revisar" : p.accion}
            </button>
          </li>
        ))}
      </ol>
    </main>
  );
}
