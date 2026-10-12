/**
 * Cliente mínimo de la API de monday (GraphQL, https://api.monday.com/v2).
 * Solo lo que el conector necesita: leer las columnas de un item y
 * publicar un update en él. El API token es por tenant.
 */
// Override por entorno para pruebas / self-host; por defecto la API real.
const ENDPOINT = process.env.MONDAY_ENDPOINT ?? "https://api.monday.com/v2";
const API_VERSION = process.env.MONDAY_API_VERSION ?? "2025-07";

export interface ColumnaItem {
  id: string;
  text: string | null;
  value: string | null;
}

export interface ItemMonday {
  id: string;
  name: string;
  /** Tablero al que pertenece el item, según la API (no según el evento). */
  boardId: string | null;
  columnas: Record<string, ColumnaItem>;
}

export interface BoardMonday {
  id: string;
  name: string;
  /** `type` de la API (BoardObjectType): board · sub_items_board · document · custom_object. */
  tipo: "board" | "sub_items_board" | "document" | "custom_object";
  /** `board_kind` de la API: private · public · share. */
  kind: "private" | "public" | "share";
  workspace: string | null;
  /**
   * Ids de los tableros de subelementos de este tablero, leídos de los
   * settings de sus columnas `subtasks` (clave `boardIds`). Vacío si no
   * tiene o si la API no entrega esa clave: entonces el de subelementos
   * se muestra suelto, nunca se oculta.
   */
  subitemsBoardIds: string[];
}

export interface PaginaBoards {
  boards: BoardMonday[];
  pagina: number;
  hayMas: boolean;
}

export const BOARDS_POR_PAGINA = 100;

export interface ColumnaBoard {
  id: string;
  title: string;
  type: string;
}

export class ClienteMonday {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #graphql(query: string, variables: Record<string, unknown>) {
    const res = await this.#fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.#token,
        "API-Version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.errors) {
      throw new Error(
        `monday API ${res.status}: ${JSON.stringify(json?.errors ?? json)}`,
      );
    }
    return json.data;
  }

  /** Lee un item con sus columnas, indexadas por columnId. */
  async getItem(itemId: string): Promise<ItemMonday | null> {
    const data = await this.#graphql(
      `query ($ids: [ID!]) {
         items (ids: $ids) {
           id
           name
           board { id }
           column_values { id text value }
         }
       }`,
      { ids: [itemId] },
    );
    const item = data?.items?.[0];
    if (!item) return null;
    const columnas: Record<string, ColumnaItem> = {};
    for (const c of item.column_values ?? []) {
      columnas[c.id] = { id: c.id, text: c.text ?? null, value: c.value ?? null };
    }
    return { id: String(item.id), name: item.name, boardId: item.board?.id !== undefined && item.board?.id !== null ? String(item.board.id) : null, columnas };
  }

  /**
   * Una página de los boards de la cuenta (para elegir de una lista). Trae
   * tipo, kind y los ids de sus tableros de subelementos. `order_by:
   * used_at` para que los recientes salgan primero; el orden alfabético lo
   * pone la plataforma.
   */
  async listarBoards(pagina = 1, limite = BOARDS_POR_PAGINA): Promise<PaginaBoards> {
    const data = await this.#consultaBoards(`limit: $limit, page: $page, state: active, order_by: used_at`, { limit: limite, page: pagina });
    const boards = (data?.boards ?? []).map(normalizarBoard);
    return { boards, pagina, hayMas: boards.length >= limite };
  }

  /**
   * Un board por id. `null` si la API no lo devuelve: no existe o el usuario
   * del token no es miembro (los privados no se ven ni por id). El id no
   * salta permisos.
   */
  async obtenerBoard(boardId: string): Promise<BoardMonday | null> {
    const data = await this.#consultaBoards(`ids: $ids`, { ids: [boardId] });
    const b = data?.boards?.[0];
    return b ? normalizarBoard(b) : null;
  }

  /**
   * Los settings de la columna de subelementos traen el id del tablero
   * hijo. El campo se llama `settings_str` en versiones anteriores de la
   * API y `settings` (JSON) en las recientes; se pide el primero y, si la
   * versión en uso ya no lo conoce, el segundo.
   */
  async #consultaBoards(args: string, variables: Record<string, unknown>): Promise<any> {
    const campos = (settings: string) => `id name type board_kind workspace { name } columns (types: [subtasks]) { id type ${settings} }`;
    const vars = Object.keys(variables).map((k) => (k === "ids" ? "$ids: [ID!]" : `$${k}: Int!`)).join(", ");
    try {
      return await this.#graphql(`query (${vars}) { boards (${args}) { ${campos("settings_str")} } }`, variables);
    } catch (err) {
      if (!/settings_str/i.test(err instanceof Error ? err.message : String(err))) throw err;
      return await this.#graphql(`query (${vars}) { boards (${args}) { ${campos("settings")} } }`, variables);
    }
  }

  /** Lista las columnas de un board (para mapear teléfono y variables). */
  async listarColumnas(boardId: string): Promise<ColumnaBoard[]> {
    const data = await this.#graphql(
      `query ($ids: [ID!]) {
         boards (ids: $ids) { columns { id title type } }
       }`,
      { ids: [boardId] },
    );
    const cols = data?.boards?.[0]?.columns ?? [];
    return cols.map((c: any) => ({ id: c.id, title: c.title, type: c.type }));
  }

  /** Publica un update (la nota/conversación del item). */
  /** Items del board cuya columna tenga alguno de los valores (items_page_by_column_values). */
  async buscarPorColumna(boardId: string, columnId: string, valores: string[]): Promise<{ id: string; nombre: string; grupo: string | null; creadoEn: string | null }[]> {
    const data = await this.#graphql(
      `query ($boardId: ID!, $columnId: String!, $valores: [String]!) {
         items_page_by_column_values (board_id: $boardId, limit: 5, columns: [{ column_id: $columnId, column_values: $valores }]) {
           items { id name created_at group { title } }
         }
       }`,
      { boardId, columnId, valores },
    );
    const items: any[] = data?.items_page_by_column_values?.items ?? [];
    return items.map((i) => ({ id: String(i.id), nombre: String(i.name ?? ""), grupo: i.group?.title ?? null, creadoEn: i.created_at ?? null }));
  }

  async crearUpdate(itemId: string, cuerpo: string): Promise<string> {
    const data = await this.#graphql(
      `mutation ($itemId: ID!, $body: String!) {
         create_update (item_id: $itemId, body: $body) { id }
       }`,
      { itemId, body: cuerpo },
    );
    return String(data.create_update.id);
  }
}

const TIPOS_BOARD = new Set(["board", "sub_items_board", "document", "custom_object"]);
const KINDS = new Set(["private", "public", "share"]);

function normalizarBoard(b: any): BoardMonday {
  const subitemsBoardIds: string[] = [];
  for (const c of b.columns ?? []) {
    if (c?.type !== "subtasks") continue;
    let settings: any = c.settings ?? null;
    if (typeof c.settings_str === "string" && c.settings_str) {
      try { settings = JSON.parse(c.settings_str); } catch { settings = null; }
    }
    for (const id of Array.isArray(settings?.boardIds) ? settings.boardIds : []) {
      if (id !== null && id !== undefined && !subitemsBoardIds.includes(String(id))) subitemsBoardIds.push(String(id));
    }
  }
  return {
    id: String(b.id),
    name: String(b.name ?? ""),
    tipo: TIPOS_BOARD.has(b.type) ? b.type : "board",
    kind: KINDS.has(b.board_kind) ? b.board_kind : "public",
    workspace: b.workspace?.name ? String(b.workspace.name) : null,
    subitemsBoardIds,
  };
}
