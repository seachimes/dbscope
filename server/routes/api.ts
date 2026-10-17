import { Hono } from "hono";
import type {
  BeforeAfter,
  ConnectRequest,
  CreateIndexRequest,
  DataFilter,
  ExplainPayload,
  IssueCode,
} from "#shared/types.ts";
import {
  closeSession,
  createSession,
  currentSession,
  getSession,
  HttpError,
} from "../core/session.ts";

import { fmt } from "../core/rules.ts";

export const api = new Hono();

/** The session id travels in a header so it never lands in browser history. */
function sessionIdOf(c: { req: { header: (k: string) => string | undefined } }) {
  return c.req.header("x-dbscope-session");
}

api.post("/connect", async (c) => {
  const body = await c.req.json<ConnectRequest>();
  validateConnect(body);
  const info = await createSession(body);
  return c.json(info);
});

// Restore only the caller's own bearer session. Never enumerate session ids.
api.get("/session", (c) => c.json(currentSession(sessionIdOf(c))));

api.post("/disconnect", async (c) => {
  const id = sessionIdOf(c);
  if (id) await closeSession(id);
  return c.json({ ok: true });
});

api.get("/overview", async (c) => {
  const session = getSession(sessionIdOf(c));
  return c.json(await session.adapter.overview(session.pool, session.info));
});

api.get("/tables/:table", async (c) => {
  const session = getSession(sessionIdOf(c));
  return c.json(
    await session.adapter.tableDetail(session.pool, session.info, c.req.param("table")),
  );
});

api.get("/tables/:table/data", async (c) => {
  const session = getSession(sessionIdOf(c));
  const q = c.req.query();
  const filter = parseFilter(q);
  const page = await session.adapter.fetchPage(
    session.pool,
    session.info.database,
    c.req.param("table"),
    {
      page: boundedInt(q.page, 1, 10_000, 1, "page"),
      pageSize: boundedInt(q.pageSize, 1, 200, 50, "pageSize"),
      orderBy: q.orderBy ?? null,
      orderDir: q.orderDir === "desc" ? "desc" : "asc",
      filter,
    },
  );
  return c.json(page);
});

api.get("/tables/:table/indexes", async (c) => {
  const session = getSession(sessionIdOf(c));
  return c.json(
    await session.adapter.listIndexes(session.pool, session.info.database, c.req.param("table")),
  );
});

api.get("/queries", async (c) => {
  const session = getSession(sessionIdOf(c));
  if (!session.info.performanceSchema.digestEnabled) {
    return c.json({
      available: false,
      reason: session.info.performanceSchema.reason ?? "performance_schema unavailable",
      queries: [],
    });
  }
  const overview = await session.adapter.overview(session.pool, session.info);
  const stats = await session.adapter.queryStats(
    session.pool,
    session.info.database,
    overview.tables.map((t) => t.name),
    boundedInt(c.req.query("limit"), 1, 200, 100, "limit"),
  );
  return c.json({ available: true, queries: stats });
});

api.post("/queries/reset", async (c) => {
  const session = getSession(sessionIdOf(c));
  // MySQL's available reset mechanisms erase server-wide statistics. Do not
  // silently mutate other databases' monitoring from this diagnostic tool.
  if (session.info.engine === "mysql") {
    throw new HttpError(
      400,
      "MySQL query statistics cannot be reset for one database; server-wide counters were not changed",
    );
  }
  await session.adapter.resetQueryStats(session.pool);
  return c.json({ ok: true });
});

api.post("/explain", async (c) => {
  const session = getSession(sessionIdOf(c));
  const { sql, analyze } = await c.req.json<{ sql: string; analyze?: boolean }>();
  if (!sql?.trim()) throw new HttpError(400, "sql is required");

  const payload = await session.adapter.explain(session.pool, session.info.database, sql, {
    analyze,
    supportsAnalyze: session.info.supportsExplainAnalyze,
  });
  return c.json(payload);
});

api.post("/indexes", async (c) => {
  const session = getSession(sessionIdOf(c));
  const body = await c.req.json<CreateIndexRequest>();
  validateIndexRequest(body);
  return c.json(await session.adapter.createIndex(session.pool, session.info.database, body));
});

api.delete("/indexes/:table/:name", async (c) => {
  const session = getSession(sessionIdOf(c));
  return c.json(
    await session.adapter.dropIndex(
      session.pool,
      session.info.database,
      c.req.param("table"),
      c.req.param("name"),
    ),
  );
});

/**
 * The improvement loop in one call: EXPLAIN, apply the DDL, EXPLAIN again,
 * and report the difference. Doing this server-side guarantees the two plans
 * are measured the same way and nothing drifts in between.
 */
api.post("/apply-and-compare", async (c) => {
  const session = getSession(sessionIdOf(c));
  const body = await c.req.json<{ sql: string; index: CreateIndexRequest }>();
  if (!body?.sql?.trim()) throw new HttpError(400, "sql is required");
  if (!body?.index?.table) throw new HttpError(400, "index.table is required");
  validateIndexRequest(body.index);

  const supportsAnalyze = session.info.supportsExplainAnalyze;
  const before = await session.adapter.explain(session.pool, session.info.database, body.sql, {
    supportsAnalyze,
  });
  const result = await session.adapter.createIndex(session.pool, session.info.database, body.index);
  let after;
  try {
    after = await session.adapter.explain(session.pool, session.info.database, body.sql, {
      supportsAnalyze,
    });
  } catch (err) {
    // DDL auto-commits in MySQL: never imply rollback when re-EXPLAIN fails.
    throw new HttpError(
      500,
      "Index was created, but re-EXPLAIN failed",
      `${result.ddl} The schema change remains applied. Re-run EXPLAIN or drop the index manually. ${(err as Error).message}`,
    );
  }

  const rowsBefore = estimatedRows(before);
  const rowsAfter = estimatedRows(after);
  const improvementPct =
    rowsBefore > 0 ? Math.round(((rowsBefore - rowsAfter) / rowsBefore) * 1000) / 10 : 0;

  const beforeCodes = new Set(before.issues.map((i) => i.code));
  const afterCodes = new Set(after.issues.map((i) => i.code));
  const resolved = [...beforeCodes].filter((code) => !afterCodes.has(code));
  const introduced = [...afterCodes].filter((code) => !beforeCodes.has(code));

  const payload: BeforeAfter = {
    before,
    after,
    ddl: result.ddl,
    fileDdl: result.fileDdl,
    verdict: {
      rowsBefore,
      rowsAfter,
      improvementPct,
      resolved: resolved as IssueCode[],
      introduced: introduced as IssueCode[],
      summary: summarize(rowsBefore, rowsAfter, improvementPct, resolved.length),
    },
  };
  return c.json(payload);
});

function validateIndexRequest(body: CreateIndexRequest): void {
  if (!body || typeof body !== "object") throw new HttpError(400, "index request is required");
  if (typeof body.table !== "string" || !body.table.trim() || body.table.length > 128) {
    throw new HttpError(400, "index.table is invalid");
  }
  if (!Array.isArray(body.columns) || body.columns.length < 1 || body.columns.length > 16) {
    throw new HttpError(400, "index.columns must contain 1 to 16 columns");
  }
  if (
    new Set(body.columns).size !== body.columns.length ||
    body.columns.some((c) => typeof c !== "string" || !c || c.length > 128)
  ) {
    throw new HttpError(400, "index.columns contains invalid or duplicate columns");
  }
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.length > 64)
  ) {
    throw new HttpError(400, "index.name must be 1 to 64 characters");
  }
}

export function validateConnect(body: ConnectRequest): void {
  if (!body || typeof body !== "object" || !body.mysql) {
    throw new HttpError(400, "database connection settings are required");
  }
  if (body.engine !== undefined && !["mysql", "postgres"].includes(body.engine)) {
    throw new HttpError(400, "unsupported database engine");
  }
  const required = [
    ["mysql.host", body.mysql.host],
    ["mysql.user", body.mysql.user],
    ["mysql.database", body.mysql.database],
  ] as const;
  for (const [name, value] of required) {
    if (typeof value !== "string" || !value.trim() || value.length > 255) {
      throw new HttpError(400, `${name} is required and must be at most 255 characters`);
    }
  }
  validPort(body.mysql.port, "mysql.port");
  if (typeof body.mysql.password !== "string" || body.mysql.password.length > 4096) {
    throw new HttpError(400, "database password must be a string (max 4096 characters)");
  }
  // node-postgres treats an empty password as missing and falls back to
  // PGPASSWORD or null. SCRAM then reports the misleading "must be a string".
  // Reject it before opening either a pool or an SSH tunnel.
  if (body.engine === "postgres" && body.mysql.password.length === 0) {
    throw new HttpError(
      400,
      "PostgreSQL database password is required; enter it in the Database password field (not the SSH key passphrase)",
    );
  }
  if (body.ssh) {
    for (const [name, value] of [
      ["ssh.host", body.ssh.host],
      ["ssh.user", body.ssh.user],
      ["ssh.privateKey", body.ssh.privateKey],
    ] as const) {
      if (typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `${name} is required`);
      }
    }
    if (
      body.ssh.host.length > 255 ||
      body.ssh.user.length > 255 ||
      body.ssh.privateKey.length > 100_000
    ) {
      throw new HttpError(400, "SSH connection setting is too long");
    }
    validPort(body.ssh.port, "ssh.port");
    if (
      body.ssh.hostKeyPolicy !== undefined &&
      !["known_hosts", "insecure"].includes(body.ssh.hostKeyPolicy)
    ) {
      throw new HttpError(400, "ssh.hostKeyPolicy must be known_hosts or insecure");
    }
  }
}

function validPort(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new HttpError(400, `${name} must be an integer from 1 to 65535`);
  }
}

function boundedInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const FILTER_OPERATORS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "is_null",
  "is_not_null",
]);

function parseFilter(q: Record<string, string>): DataFilter | null {
  if (!q.filterColumn && !q.filterOperator && q.filterValue === undefined) return null;
  const column = q.filterColumn?.trim();
  const operator = q.filterOperator?.trim();
  if (!column || column.length > 128) throw new HttpError(400, "invalid filter column");
  if (!operator || !FILTER_OPERATORS.has(operator)) {
    throw new HttpError(400, "invalid filter operator");
  }
  const needsValue = operator !== "is_null" && operator !== "is_not_null";
  if (needsValue && q.filterValue === undefined) {
    throw new HttpError(400, "filter value is required");
  }
  if ((q.filterValue?.length ?? 0) > 2_000) {
    throw new HttpError(400, "filter value is too long");
  }
  return { column, operator: operator as DataFilter["operator"], value: q.filterValue };
}

/**
 * The estimated rows a plan has to touch, used as the Before/After metric.
 *
 * MySQL exposes tabular EXPLAIN rows, and the product is the right figure there
 * because nested-loop joins multiply. PostgreSQL has no such table and leaves
 * `rows` empty, so the estimate is taken from the plan steps instead — without
 * this, an empty product of 1 made every PostgreSQL comparison report "no
 * change" no matter how much the index helped.
 */
function estimatedRows(payload: ExplainPayload): number {
  if (payload.rows.length > 0) {
    return payload.rows.reduce((acc, r) => acc * Math.max(r.rows ?? 1, 1), 1);
  }
  // Steps are leaf-first, so the widest scan is the work the index must remove.
  return payload.steps.reduce((acc, step) => Math.max(acc, step.rows ?? 0), 0);
}

function summarize(before: number, after: number, pct: number, resolvedCount: number): string {
  if (after < before) {
    const factor = after > 0 ? Math.round((before / after) * 10) / 10 : before;
    return `Estimated rows examined fell from ${fmt(before)} to ${fmt(after)} (${factor}× less, −${pct}%)${
      resolvedCount > 0 ? `, and ${resolvedCount} issue(s) disappeared` : ""
    }.`;
  }
  if (after === before) {
    return `No change: the planner still estimates ${fmt(after)} rows. The index may not apply to this query — check the column order and any functions wrapping the column.`;
  }
  return `Worse: estimated rows rose from ${fmt(before)} to ${fmt(after)}. Consider dropping this index.`;
}
