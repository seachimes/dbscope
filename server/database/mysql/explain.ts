import type { Pool, RowDataPacket } from "mysql2/promise";
import type {
  ExplainPayload,
  ExplainRow,
  IndexInfo,
  IndexSuggestion,
  PlanStep,
  Severity,
} from "#shared/types.ts";
import { explainIssues, fmt } from "../../core/rules.ts";
import { queryAdvice } from "../../core/advice.ts";
import {
  assertExplainable,
  extractEqualityColumns,
  extractOrderColumns,
} from "../../core/sql-guard.ts";

/** EXPLAIN ANALYZE really runs the statement, so it gets a hard time limit. */
const MAX_EXECUTION_MS = 5_000;

function normalize(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

export async function runExplain(
  pool: Pool,
  sql: string,
  opts: { analyze?: boolean | undefined; supportsAnalyze?: boolean | undefined } = {},
): Promise<ExplainPayload> {
  assertExplainable(sql);
  const statement = normalize(sql);
  const started = performance.now();

  const [rawRows] = await pool.query<RowDataPacket[]>(`EXPLAIN ${statement}`);
  const rows: ExplainRow[] = rawRows.map((r) => ({
    id: Number(r.id ?? 0),
    selectType: String(r.select_type ?? ""),
    table: r.table === null ? null : String(r.table),
    partitions: r.partitions === null ? null : String(r.partitions),
    type: r.type === null ? null : String(r.type),
    possibleKeys: r.possible_keys === null ? null : String(r.possible_keys),
    key: r.key === null ? null : String(r.key),
    keyLen: r.key_len === null ? null : String(r.key_len),
    ref: r.ref === null ? null : String(r.ref),
    rows: r.rows === null ? null : Number(r.rows),
    filtered: r.filtered === null ? null : Number(r.filtered),
    extra: r.Extra === null || r.Extra === undefined ? null : String(r.Extra),
  }));

  // FORMAT=JSON carries the cost model; useful, but never worth failing over.
  let json: unknown = null;
  try {
    const [jsonRows] = await pool.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${statement}`);
    const raw = jsonRows[0]?.EXPLAIN;
    json = typeof raw === "string" ? JSON.parse(raw) : (raw ?? null);
  } catch {
    json = null;
  }

  let analyze: string | null = null;
  if (opts.analyze && opts.supportsAnalyze) {
    const connection = await pool.getConnection();
    try {
      // EXPLAIN ANALYZE really executes the SELECT. Cap server-side execution
      // time on the same connection so a mistaken scan cannot run indefinitely.
      await connection.query("SET SESSION max_execution_time = ?", [MAX_EXECUTION_MS]);
      const [analyzeRows] = await connection.query<RowDataPacket[]>(`EXPLAIN ANALYZE ${statement}`);
      // Returns one column whose name varies; take the first value of each row.
      analyze = analyzeRows.map((r) => String(Object.values(r)[0] ?? "")).join("\n");
    } catch (err) {
      analyze = `EXPLAIN ANALYZE failed or timed out after ${MAX_EXECUTION_MS} ms: ${(err as Error).message}`;
    } finally {
      await connection.query("SET SESSION max_execution_time = 0").catch(() => {});
      connection.release();
    }
  }

  const steps = buildSteps(rows);
  const issues = explainIssues(rows);
  const estimatedCost = rows.reduce((acc, r) => acc * Math.max(r.rows ?? 1, 1), 1);

  return {
    sql: statement,
    rows,
    steps,
    issues,
    estimatedCost,
    json,
    analyze,
    elapsedMs: Math.round(performance.now() - started),
    advice: queryAdvice({
      digestText: statement,
      execCount: 1,
      totalTimeMs: 0,
      avgTimeMs: 0,
      rowsExamined: estimatedCost,
      rowsSent: 0,
    }).filter((item) => item.kind !== "measure"),
    suggestions: [],
  };
}

const TYPE_KIND: Record<string, PlanStep["kind"]> = {
  ALL: "full_scan",
  index: "index_scan",
  range: "range",
  ref: "ref",
  eq_ref: "eq_ref",
  const: "const",
  system: "const",
  fulltext: "ref",
  ref_or_null: "ref",
  index_merge: "range",
  unique_subquery: "eq_ref",
  index_subquery: "ref",
};

const TYPE_LABEL: Record<string, string> = {
  ALL: "FULL SCAN",
  index: "INDEX-ORDER SCAN",
  range: "RANGE SCAN",
  ref: "INDEX LOOKUP",
  eq_ref: "UNIQUE LOOKUP",
  const: "CONST",
  system: "CONST",
  ref_or_null: "INDEX LOOKUP (+NULL)",
  index_merge: "INDEX MERGE",
};

/**
 * Turn EXPLAIN's table-shaped output into a linear pipeline of boxes.
 *
 * EXPLAIN reads top-to-bottom as the join order, so each row becomes an access
 * step, and post-processing (sort, temp table, limit) is appended as its own
 * step. This is a readable approximation of execution, not the exact iterator
 * tree — the tree is available under EXPLAIN ANALYZE for anyone who wants it.
 */
function buildSteps(rows: ExplainRow[]): PlanStep[] {
  const steps: PlanStep[] = [];
  let needsSort = false;
  let needsTemp = false;

  rows.forEach((row, i) => {
    const type = row.type ?? "";
    const kind = TYPE_KIND[type] ?? "table";
    const extra = row.extra ?? "";
    const notes: string[] = [];

    let severity: Severity | "none" = "none";
    if (type === "ALL") {
      severity = (row.rows ?? 0) > 10_000 ? "critical" : "warning";
      notes.push("Reads every row in the table.");
    } else if (type === "index") {
      // MySQL type=index means an ordered index traversal, not a keyed lookup.
      // It may still be excellent for ORDER BY ... LIMIT when only a few rows
      // are estimated, so severity must account for how much will be scanned.
      severity = (row.rows ?? 0) > 10_000 ? "warning" : "none";
      notes.push(
        (row.rows ?? 0) > 10_000
          ? "Walks a large part of the index in order; this is not a keyed lookup."
          : "Reads the index in order. This can be efficient when LIMIT stops after a few rows.",
      );
    } else if (type === "range") {
      notes.push("Reads a bounded slice of the index.");
    } else if (type === "eq_ref" || type === "const" || type === "system") {
      notes.push("At most one row. This is as good as it gets.");
    }

    if (row.key === null && type && type !== "ALL") notes.push("No index used.");
    if (row.possibleKeys && !row.key) {
      notes.push(`Candidates ignored: ${row.possibleKeys}`);
    }
    if (/Using where/i.test(extra)) notes.push("Rows are filtered after being read.");
    if (/Using index\b/i.test(extra) && !/Using index condition/i.test(extra)) {
      notes.push("Covering index: the table itself is never touched.");
    }
    if (/Using index condition/i.test(extra)) {
      notes.push("Index condition pushdown is in effect.");
    }
    if (/Using join buffer/i.test(extra)) {
      notes.push("Join buffer in use — the joined table has no usable index.");
      severity = "critical";
    }
    if (/Using filesort/i.test(extra)) needsSort = true;
    if (/Using temporary/i.test(extra)) needsTemp = true;

    const label = TYPE_LABEL[type] ?? (type ? type.toUpperCase() : "ACCESS");
    const tableName = row.table ?? `<derived${row.id}>`;

    steps.push({
      id: `access-${i}`,
      kind,
      label,
      sublabel: row.key ? `key: ${row.key}` : "key: NULL",
      table: tableName,
      rows: row.rows ?? undefined,
      severity,
      notes,
    });

    // A second table in the plan means a join happened between them.
    if (i > 0) {
      const prev = rows[i - 1];
      steps.splice(steps.length - 1, 0, {
        id: `join-${i}`,
        kind: "join",
        label: "JOIN",
        sublabel: row.ref ? `on ${row.ref}` : undefined,
        severity: /Using join buffer/i.test(extra) ? "critical" : "none",
        notes: /Using join buffer/i.test(extra)
          ? [
              `Each row from ${prev?.table ?? "the previous step"} is matched by scanning ${tableName}.`,
            ]
          : [],
      });
    }
  });

  if (needsTemp) {
    steps.push({
      id: "temporary",
      kind: "temporary",
      label: "TEMPORARY TABLE",
      severity: "warning",
      notes: ["Intermediate results are materialized before the next stage."],
    });
  }

  if (needsSort) {
    steps.push({
      id: "filesort",
      kind: "filesort",
      label: "FILESORT",
      severity: "warning",
      notes: [
        "All matching rows are sorted before any are returned, so LIMIT cannot stop the work early.",
      ],
    });
  }

  steps.push({
    id: "result",
    kind: "result",
    label: "RESULT",
    severity: "none",
    notes: [],
  });

  return steps;
}

/** Exposed only for deterministic plan-label tests; production uses runExplain. */
export const buildPlanStepsForTest = buildSteps;

/**
 * Suggest indexes from the plan plus the real schema.
 *
 * This is deliberately conservative: it proposes an index only where EXPLAIN
 * shows a scan and the SQL names a column that would remove it. No cost model,
 * no guessing at multi-column ordering beyond equality-then-sort, and anything
 * already covered is marked redundant rather than hidden.
 */
export function suggestIndexes(
  payload: ExplainPayload,
  indexesByTable: Map<string, IndexInfo[]>,
): IndexSuggestion[] {
  const sql = payload.sql;
  const suggestions: IndexSuggestion[] = [];
  const seen = new Set<string>();

  for (const row of payload.rows) {
    const table = row.table;
    if (!table || table.startsWith("<")) continue;
    const scanning = row.type === "ALL" || row.type === "index" || row.key === null;
    const sorting = /Using filesort/i.test(row.extra ?? "");
    if (!scanning && !sorting) continue;

    const equality = extractEqualityColumns(sql, table);
    const ordering = extractOrderColumns(sql);
    // Equality columns first, then the sort column: the standard shape that
    // lets one index satisfy both the filter and the ORDER BY.
    const columns = [...new Set([...equality, ...ordering])].slice(0, 3);
    if (columns.length === 0) continue;

    const existing = indexesByTable.get(table) ?? [];
    const redundant = existing.some((idx) => columns.every((c, i) => idx.columns[i] === c));

    const key = `${table}:${columns.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = `idx_${columns.join("_")}`.slice(0, 60);
    suggestions.push({
      table,
      columns,
      reason:
        row.type === "ALL"
          ? `EXPLAIN shows a full scan of ~${fmt(row.rows ?? 0)} rows; these columns appear in the WHERE/ORDER BY.`
          : sorting
            ? "An index in this order lets MySQL return sorted rows without a filesort."
            : "No index was used for this access.",
      ddl: `ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${columns.map((c) => `\`${c}\``).join(", ")});`,
      confidence: equality.length > 0 && (sorting || row.type === "ALL") ? "high" : "medium",
      tradeoffs: [
        "Adds disk/buffer-pool usage and work to INSERT/UPDATE/DELETE.",
        "Keep it only if re-EXPLAIN and the benchmark improve.",
        ...(redundant
          ? ["An existing index already covers this prefix; do not create a duplicate."]
          : []),
      ],
      redundant,
    });
  }

  return suggestions;
}
