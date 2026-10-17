import type {
  BeforeAfter,
  ConnectRequest,
  CreateIndexRequest,
  DataFilter,
  DataPage,
  ExplainPayload,
  IndexInfo,
  IndexMutationResult,
  OverviewPayload,
  QueryStat,
  SessionInfo,
} from "#shared/types.ts";

/**
 * Per tab: survives a reload, but closing the tab forgets the bearer id instead
 * of leaving it readable by every later visit to this origin.
 */
const SESSION_KEY = "dbscope.session";

// Ids from builds that kept them in localStorage must not outlive the upgrade.
localStorage.removeItem(SESSION_KEY);
localStorage.removeItem("sonde.session");

let sessionId: string | null = sessionStorage.getItem(SESSION_KEY);
let onSessionExpired: (() => void) | null = null;

export function getSessionId(): string | null {
  return sessionId;
}

export function setSessionId(id: string | null): void {
  sessionId = id;
  if (id) sessionStorage.setItem(SESSION_KEY, id);
  else sessionStorage.removeItem(SESSION_KEY);
}

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (sessionId) headers.set("x-dbscope-session", sessionId);

  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = body?.error ?? `request failed (${res.status})`;
    // A dead session must not leave the UI pretending to be connected.
    if (res.status === 401) {
      setSessionId(null);
      onSessionExpired?.();
    }
    throw new ApiFailure(message, res.status, body?.code);
  }
  return body as T;
}

export const api = {
  connect: (req: ConnectRequest) =>
    request<SessionInfo>("/connect", { method: "POST", body: JSON.stringify(req) }),

  disconnect: () => request<{ ok: true }>("/disconnect", { method: "POST" }),

  overview: () => request<OverviewPayload>("/overview"),

  table: (name: string) =>
    request<import("#shared/types.ts").TableDetailPayload>(`/tables/${encodeURIComponent(name)}`),

  tableData: (
    name: string,
    opts: {
      page?: number;
      pageSize?: number;
      orderBy?: string | null;
      orderDir?: string;
      filter?: DataFilter | null;
    },
  ) => {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize));
    if (opts.orderBy) params.set("orderBy", opts.orderBy);
    if (opts.orderDir) params.set("orderDir", opts.orderDir);
    if (opts.filter) {
      params.set("filterColumn", opts.filter.column);
      params.set("filterOperator", opts.filter.operator);
      if (opts.filter.value !== undefined) params.set("filterValue", opts.filter.value);
    }
    return request<DataPage>(`/tables/${encodeURIComponent(name)}/data?${params}`);
  },

  indexes: (table: string) => request<IndexInfo[]>(`/tables/${encodeURIComponent(table)}/indexes`),

  queries: () => request<{ available: boolean; reason?: string; queries: QueryStat[] }>("/queries"),

  resetQueries: () => request<{ ok: true }>("/queries/reset", { method: "POST" }),

  explain: (sql: string, analyze = false) =>
    request<ExplainPayload>("/explain", {
      method: "POST",
      body: JSON.stringify({ sql, analyze }),
    }),

  createIndex: (req: CreateIndexRequest) =>
    request<IndexMutationResult>("/indexes", { method: "POST", body: JSON.stringify(req) }),

  dropIndex: (table: string, name: string) =>
    request<IndexMutationResult>(
      `/indexes/${encodeURIComponent(table)}/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  applyAndCompare: (sql: string, index: CreateIndexRequest) =>
    request<BeforeAfter>("/apply-and-compare", {
      method: "POST",
      body: JSON.stringify({ sql, index }),
    }),
};
