import type { Yo } from "./api.ts";
import { diasRestantesPrueba, nombrePlan } from "./plan.ts";

// Contacto para contratar. Stripe todavía no existe: en vez de un botón de
// pago muerto, un canal real y manual (correo, y WhatsApp si se configura).
const CONTACTO_EMAIL =
  (import.meta.env.VITE_CONTACTO_EMAIL as string | undefined) ??
  "info@digsol.com.mx";
const CONTACTO_WHATSAPP = import.meta.env.VITE_CONTACTO_WHATSAPP as
  | string
  | undefined;

/**
 * Vista de cuenta: plan actual, uso contra los límites, vigencia y cómo
 * contratar. Se abre desde el badge de plan.
 */
export function Cuenta(props: {
  yo: Yo;
  lineasUsadas: number;
  conectoresUsados: number;
  alCerrar: () => void;
}) {
  const { yo } = props;
  const enPrueba = yo.plan === "prueba";
  const dias = diasRestantesPrueba(yo.pruebaExpiraEn);

  const vigencia = !enPrueba
    ? "Plan activo."
    : !yo.pruebaVigente
      ? "Tu prueba terminó. Tus datos siguen guardados y tus sesiones quedaron desconectadas; al contratar un plan, reconectas donde estabas."
      : dias === null
        ? "Prueba activa."
        : dias <= 0
          ? "Tu prueba termina hoy."
          : `Te quedan ${dias} día${dias === 1 ? "" : "s"} de prueba.`;

  const asunto = encodeURIComponent("Quiero contratar Cauce");
  const cuerpo = encodeURIComponent(
    `Hola, uso Cauce (cuenta ${yo.nombre}) y quiero contratar un plan.`,
  );
  const mailto = `mailto:${CONTACTO_EMAIL}?subject=${asunto}&body=${cuerpo}`;
  const wa = CONTACTO_WHATSAPP
    ? `https://wa.me/${CONTACTO_WHATSAPP.replace(/[^\d]/g, "")}?text=${cuerpo}`
    : null;

  return (
    <div className="modal-fondo" onClick={props.alCerrar}>
      <div
        className="modal modal--ancho cuenta"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Tu cuenta</h2>

        <div className="cuenta__plan">
          <span className="cuenta__plan-nombre">{nombrePlan(yo.plan)}</span>
          <span className="consola__sub">{vigencia}</span>
        </div>

        <dl className="cuenta__uso">
          <Uso etq="Líneas (números)" usado={props.lineasUsadas} total={yo.limites.lineas} />
          <Uso etq="Conexiones con CRM" usado={props.conectoresUsados} total={yo.limites.conectores} />
        </dl>

        <div className="cuenta__contratar">
          <h3>{enPrueba ? "Cómo contratar" : "¿Necesitas más líneas?"}</h3>
          <p className="consola__sub">
            Escríbenos y activamos tu plan. Todavía no cobramos en línea; lo
            hacemos contigo directo.
          </p>
          <div className="fila-inline">
            <a className="boton boton--primario" href={mailto}>
              Escribir a {CONTACTO_EMAIL}
            </a>
            {wa && (
              <a className="boton" href={wa} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            )}
          </div>
        </div>

        <div className="modal__acciones">
          <button className="boton" onClick={props.alCerrar}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function Uso(props: { etq: string; usado: number; total: number }) {
  const lleno = props.usado >= props.total;
  return (
    <div className="cuenta__uso-fila">
      <dt>{props.etq}</dt>
      <dd className={lleno ? "cuenta__uso-lleno" : undefined}>
        {props.usado} de {props.total}
      </dd>
    </div>
  );
}
