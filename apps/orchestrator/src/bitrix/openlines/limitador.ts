/**
 * Límites del carril inmediato para respuestas de operador:
 * - espaciado mínimo entre mensajes a la MISMA conversación (se espera);
 * - tope de ráfaga por línea: más de N mensajes en M segundos → el
 *   excedente va a la cola normal (se registra), no se descarta.
 * Vive en memoria: es protección del número, no contabilidad.
 */
export class LimitadorInmediato {
  #ultimoPorConversacion = new Map<string, number>();
  #enviosPorLinea = new Map<string, number[]>();

  /** Milisegundos a esperar antes de enviar a esta conversación (0 si ya pasó el espaciado). */
  esperaPara(clave: string, espaciadoMs: number, ahora: number = Date.now()): number {
    const ultimo = this.#ultimoPorConversacion.get(clave);
    if (ultimo === undefined) return 0;
    return Math.max(0, ultimo + espaciadoMs - ahora);
  }

  /** ¿La línea ya alcanzó su tope en la ventana? (no registra el envío) */
  rafagaSuperada(instanceId: string, n: number, segundos: number, ahora: number = Date.now()): boolean {
    const desde = ahora - segundos * 1000;
    const recientes = (this.#enviosPorLinea.get(instanceId) ?? []).filter((t) => t >= desde);
    this.#enviosPorLinea.set(instanceId, recientes);
    return recientes.length >= n;
  }

  /** Registra un envío inmediato hecho. */
  registrar(clave: string, instanceId: string, ahora: number = Date.now()): void {
    this.#ultimoPorConversacion.set(clave, ahora);
    const lista = this.#enviosPorLinea.get(instanceId) ?? [];
    lista.push(ahora);
    this.#enviosPorLinea.set(instanceId, lista);
  }
}
