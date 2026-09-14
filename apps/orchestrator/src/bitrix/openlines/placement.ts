import type { InstanceEstado } from "@cauce/core";
import { etiquetaLinea, formatearNumero } from "./tipos.ts";

/**
 * Página del placement SETTING_CONNECTOR: vive DENTRO de Bitrix (panel
 * lateral del Contact Center) y debe verse como parte de Bitrix, no como
 * parte nuestra. Solo HTML y CSS en línea; sin scripts externos.
 *
 * Bitrix nos dice qué línea abierta se está configurando (LINE). La
 * página muestra los números de WhatsApp del tenant con su estado real y
 * el cliente elige cuál la atiende. Reasignar un número que ya atiende
 * otra línea, o sumar un número a una línea que ya tiene otros, pide
 * confirmación explícita: nada silencioso.
 */

export interface LineaPlacement {
  instanceId: string;
  /** Nombre que le puso el cliente; null → se muestra el número. */
  nombre: string | null;
  numero: string | null;
  estado: InstanceEstado;
  /** La sesión existe en el gestor (contenedor vivo). */
  viva: boolean;
  /** Línea abierta que atiende hoy, o null. */
  lineId: number | null;
}

export type AvisoPlacement =
  | { tipo: "reasignacion"; lineaActual: number }
  | { tipo: "compartida"; numeros: string[] }
  | { tipo: "error"; mensaje: string }
  | { tipo: "ok"; instanceId: string; numero: string | null; nombre: string | null };

export interface ModeloPlacement {
  line: number;
  lineaNombre: string | null;
  connectorId: string;
  /** Token cifrado que autentica el POST de vuelta desde la página. */
  token: string;
  lineas: LineaPlacement[];
  /** instanceId preseleccionado (el que ya atiende esta línea, o el que se intentó asignar). */
  seleccion: string | null;
  aviso: AvisoPlacement | null;
  urlContactCenter: string | null;
}

const esc = (s: string | number | null | undefined): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Estado por forma y color (verificado en escala de grises: la forma distingue). */
function estadoVisual(l: LineaPlacement): { clase: string; texto: string } {
  if (l.viva && l.estado === "connected") return { clase: "dot dot-ok", texto: "Conectada" };
  if (l.viva && l.estado === "qr") return { clase: "dot dot-qr", texto: "Sin vincular: pide escanear el QR" };
  if (l.viva && l.estado === "pending") return { clase: "dot dot-qr", texto: "Iniciando" };
  if (!l.viva && l.estado === "connected") return { clase: "dot dot-off", texto: "Sin sesión viva" };
  return { clase: "dot dot-off", texto: "Desconectada" };
}

const CSS = `
  *{box-sizing:border-box}
  body{margin:0;padding:20px 24px;font:14px/1.45 "Helvetica Neue",Arial,sans-serif;color:#333;background:#fff}
  h1{font-size:18px;font-weight:600;margin:0 0 4px}
  .sub{color:#828b95;margin:0 0 16px;font-size:13px}
  .aviso{border-radius:4px;padding:10px 12px;margin:0 0 14px;font-size:13px;border:1px solid}
  .aviso-ok{background:#f3fbe9;border-color:#c5e79c}
  .aviso-warn{background:#fff7e0;border-color:#f7d77a}
  .aviso-err{background:#fdecea;border-color:#f5b5ad}
  .aviso strong{font-weight:600}
  .lista{list-style:none;margin:0 0 16px;padding:0;border:1px solid #e7e9ec;border-radius:4px}
  .lista li{border-top:1px solid #e7e9ec}
  .lista li:first-child{border-top:0}
  .lista label{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;cursor:pointer}
  .lista input[type=radio]{margin:4px 0 0}
  .num{font-weight:600}
  .meta{color:#828b95;font-size:12px;margin-top:2px}
  .id{font-family:Menlo,Consolas,monospace;font-size:11px;color:#a8adb4;margin-top:2px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
  .dot-ok{background:#9dcf00}
  .dot-qr{border:2px dotted #f7a700;width:10px;height:10px}
  .dot-off{border:2px solid #f1361b;width:10px;height:10px}
  .ya{display:inline-block;background:#eef2f5;color:#525c69;border-radius:3px;padding:1px 6px;font-size:11px;margin-left:6px}
  .confirma{display:block;margin:10px 0 0;font-size:13px}
  .btn{display:inline-block;border:0;border-radius:4px;padding:9px 18px;font:600 13px/1 "Helvetica Neue",Arial,sans-serif;text-transform:uppercase;cursor:pointer}
  .btn-primary{background:#2fc6f6;color:#fff}
  .btn-primary:hover{background:#0fb4ea}
  .btn[disabled]{opacity:.5;cursor:default}
  .pie{color:#828b95;font-size:12px;margin-top:14px}
  .pie a{color:#2067b0}
  .vacio{padding:14px;color:#828b95}
`;

function aviso(a: AvisoPlacement | null, line: number): string {
  if (!a) return "";
  if (a.tipo === "ok") {
    return `<div class="aviso aviso-ok"><span class="dot dot-ok"></span><strong>Conectado en la línea abierta ${esc(line)} · ${esc(etiquetaLinea({ id: a.instanceId, numero: a.numero, nombre: a.nombre }))}</strong><div class="id">Instancia ${esc(a.instanceId)}</div></div>`;
  }
  if (a.tipo === "reasignacion") {
    return `<div class="aviso aviso-warn"><strong>Este número ya atiende la línea abierta ${esc(a.lineaActual)}.</strong> Al conectarlo aquí deja de atender la ${esc(a.lineaActual)}. Confirma abajo para continuar.</div>`;
  }
  if (a.tipo === "compartida") {
    return `<div class="aviso aviso-warn"><strong>Esta línea abierta ya la atienden ${esc(a.numeros.join(" y "))}.</strong> El número que elegiste se sumará y los chats de todos llegarán a la misma cola. Confirma abajo para continuar.</div>`;
  }
  return `<div class="aviso aviso-err"><strong>No se pudo conectar.</strong> ${esc(a.mensaje)}</div>`;
}

export function htmlPlacement(m: ModeloPlacement): string {
  const enEsta = m.lineas.filter((l) => l.lineId === m.line);
  const opciones = m.lineas.length === 0
    ? `<li class="vacio">Este tenant todavía no tiene números de WhatsApp conectados. Conecta uno en la plataforma de Digsol Factory y vuelve aquí.</li>`
    : m.lineas.map((l) => {
        const ev = estadoVisual(l);
        const marcado = m.seleccion === l.instanceId ? " checked" : "";
        const ya = l.lineId === null ? "" : l.lineId === m.line ? `<span class="ya">atiende esta línea</span>` : `<span class="ya">ya atiende la línea abierta ${esc(l.lineId)}</span>`;
        const numero = formatearNumero(l.numero);
        const principal = l.nombre ?? numero ?? "Sin número todavía";
        return `<li><label><input type="radio" name="instanceId" value="${esc(l.instanceId)}"${marcado} required>
          <div><div class="num">${esc(principal)}${ya}</div>
          ${l.nombre ? `<div class="meta">${esc(numero ?? "Sin número todavía")}</div>` : ""}
          <div class="meta"><span class="${ev.clase}"></span>${esc(ev.texto)}</div>
          <div class="id">${esc(l.instanceId)}</div></div></label></li>`;
      }).join("");

  const confirmaciones = m.aviso?.tipo === "reasignacion"
    ? `<label class="confirma"><input type="checkbox" name="confirmar_reasignacion" value="1" required> Entiendo que deja de atender la línea abierta ${esc(m.aviso.lineaActual)}.</label>`
    : m.aviso?.tipo === "compartida"
      ? `<label class="confirma"><input type="checkbox" name="confirmar_compartida" value="1" required> Entiendo que esta línea abierta se comparte entre varios números.</label>`
      : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp · Digsol Factory</title><style>${CSS}</style></head><body>
<h1>WhatsApp · Digsol Factory</h1>
<p class="sub">Línea abierta ${esc(m.line)}${m.lineaNombre ? ` · ${esc(m.lineaNombre)}` : ""}${enEsta.length ? ` · la atienden ${esc(enEsta.map((l) => etiquetaLinea({ id: l.instanceId, numero: l.numero, nombre: l.nombre })).join(", "))}` : " · sin número asignado"}</p>
${aviso(m.aviso, m.line)}
<form method="post" action="">
  <input type="hidden" name="accion" value="asignar">
  <input type="hidden" name="token" value="${esc(m.token)}">
  <ul class="lista">${opciones}</ul>
  ${confirmaciones}
  <p><button class="btn btn-primary" type="submit"${m.lineas.length === 0 ? " disabled" : ""}>Conectar</button></p>
</form>
<p class="pie">Los mensajes de WhatsApp del número elegido llegan a esta línea abierta y las respuestas de tus operadores salen por WhatsApp.${m.urlContactCenter ? ` <a href="${esc(m.urlContactCenter)}" target="_top">Equipo y horario de la línea</a>.` : ""}<br><span class="id">Conector ${esc(m.connectorId)}</span></p>
</body></html>`;
}

/** Página mínima para rechazos (member_id ajeno, token vencido…). */
export function htmlRechazo(mensaje: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>WhatsApp · Digsol Factory</title><style>${CSS}</style></head><body><h1>WhatsApp · Digsol Factory</h1><div class="aviso aviso-err">${esc(mensaje)}</div></body></html>`;
}
