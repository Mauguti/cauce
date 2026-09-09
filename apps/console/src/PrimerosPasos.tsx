import { Check } from "lucide-react";

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

      <ol className="flex flex-col gap-3">
        {pasos.map((p) => (
          <li
            key={p.n}
            className={`flex flex-col gap-3 rounded-lg border border-sys-border bg-sys-bg p-4 shadow-clean sm:flex-row sm:items-center sm:gap-4 ${p.hecho ? "opacity-70" : ""}`}
          >
            <div className="flex items-start gap-4 sm:contents">
              <span
                aria-hidden
                className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-sm font-semibold ${
                  p.hecho
                    ? "bg-accent-green/15 text-accent-green"
                    : "border-2 border-accent-blue text-accent-blue"
                }`}
              >
                {p.hecho ? <Check className="h-5 w-5" strokeWidth={3} /> : p.n}
              </span>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-sys-text">{p.titulo}</h2>
                <p className="text-sm text-sys-muted">{p.texto}</p>
              </div>
            </div>
            <button
              className={`${p.hecho ? "boton" : "boton boton--primario"} w-full shrink-0 sm:w-auto`}
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
