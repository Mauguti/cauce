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
  columnas: Record<string, ColumnaItem>;
}

export interface BoardMonday {
  id: string;
  name: string;
}

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
    return { id: String(item.id), name: item.name, columnas };
  }

  /** Lista los boards de la cuenta (para elegir de una lista, no IDs). */
  async listarBoards(): Promise<BoardMonday[]> {
    const data = await this.#graphql(
      `query { boards (limit: 100, state: active) { id name } }`,
      {},
    );
    return (data?.boards ?? []).map((b: any) => ({
      id: String(b.id),
      name: b.name,
    }));
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
