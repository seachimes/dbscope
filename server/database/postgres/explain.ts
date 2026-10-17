import type { Pool } from "pg";
import type { ExplainPayload, IndexInfo, IndexSuggestion, Issue, PlanStep } from "#shared/types.ts";
import {
  assertExplainable,
  extractEqualityColumns,
  extractOrderColumns,
} from "../../core/sql-guard.ts";
import { queryAdvice } from "../../core/advice.ts";
import { fmt } from "../../core/rules.ts";
import { SCHEMA } from "./sql.ts";
import { indexDdlFor } from "./data.ts";

/** A node of PostgreSQL's `EXPLAIN (FORMAT JSON)` output. */
export interface PgPlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Total Cost"?: number;
  "Rows Removed by Filter"?: number;
  "Sort Space Type"?: string;
  Filter?: string;
  Plans?: PgPlanNode[];
}

/** A sequential scan only matters once it is reading a lot of rows. */
const LARGE_SCAN_ROWS = 10_000;

function classify(nodeType: string): PlanStep["kind"] {
  if (nodeType === "Seq Scan") return "full_scan";
  if (nodeType.includes("Index Only Scan")) return "index_scan";
  if (nodeType.includes("Index Scan")) return "ref";
  if (nodeType.includes("Bitmap")) return "range";
  if (nodeType.includes("Join") || nodeType.includes("Nested Loop")) return "join";
  if (nodeType === "Sort" || nodeType === "Incremental Sort") return "filesort";
  if (nodeType.includes("Aggregate") || nodeType === "Group") return "group";
  return "table";
}

/**
 * How many rows this node actually has to read.
 *
 * PostgreSQL's `Plan Rows`/`Actual Rows` are rows *emitted*, not rows examined:
 * a sequential scan of 50,000 rows that matches 25 reports 25. The work the
 * plan performs — and what an index would remove — is the emitted rows plus the
 * rows the filter discarded, which is the figure MySQL's `rows` column means.
 *
 * A nested loop's inner side reports per-loop values, so the total is
 * multiplied by the loop count.
 */
function rowsRead(node: PgPlanNode): number {
  const emitted = node["Actual Rows"] ?? node["Plan Rows"] ?? 0;
  const discarded = Number(node["Rows Removed by Filter"] ?? 0);
  const loops = Math.max(Number(node["Actual Loops"] ?? 1), 1);
  return Math.round((Number(emitted) + discarded) * loops);
}

/**
 * Estimated rows read when the plan was not executed.
 *
 * Without ANALYZE there is no `Rows Removed by Filter`, so a filtered scan
 * would look as cheap as its output. A `Filter` on a scan means the relation is
 * being read in full, so the table's own row estimate is the honest figure.
 */
function estimatedRowsRead(node: PgPlanNode, relationRows?: number): number {
  const direct = rowsRead(node);
  if (node["Actual Rows"] !== undefined) return direct;
  if (node.Filter && relationRows !== undefined) {
    return Math.max(
      direct,
      Math.round(relationRows * Math.max(Number(node["Actual Loops"] ?? 1), 1)),
    );
  }
  return direct;
}

function severityOf(kind: PlanStep["kind"], rows: number, node: PgPlanNode): PlanStep["severity"] {
  if (kind === "full_scan") return rows > LARGE_SCAN_ROWS ? "critical" : "warning";
  if (kind === "filesort" && node["Sort Space Type"] === "Disk") return "critical";
  if (Number(node["Rows Removed by Filter"] ?? 0) > LARGE_SCAN_ROWS) return "warning";
  return "none";
}

/**
 * Flatten the plan tree into the pipeline the UI draws, children first, so the
 * steps read in execution order rather than in planner order.
 */
export function buildPlanSteps(
  root: PgPlanNode | undefined,
  /** Estimated row counts per relation, used when the plan was not executed. */
  relationRows: Map<string, number> = new Map(),
): PlanStep[] {
  const steps: PlanStep[] = [];
  if (!root) return steps;

  const walk = (node: PgPlanNode): void => {
    for (const child of node.Plans ?? []) walk(child);

    const nodeType = String(node["Node Type"] ?? "Plan");
    const kind = classify(nodeType);
    const rows = estimatedRowsRead(node, relationRows.get(String(node["Relation Name"] ?? "")));
    const removed = Number(node["Rows Removed by Filter"] ?? 0);

    const notes: string[] = [];
    if (node.Filter) notes.push(`Filter: ${node.Filter}`);
    if (removed > 0) notes.push(`${fmt(removed)} rows discarded by the filter`);
    if (node["Sort Space Type"] === "Disk") notes.push("Sort spilled to disk");

    steps.push({
      id: `pg-${steps.length}`,
      kind,
      label: nodeType.toUpperCase(),
      table: node["Relation Name"],
      rows: rows || undefined,
      severity: severityOf(kind, rows, node),
      sublabel: node["Index Name"] ? `index: ${node["Index Name"]}` : undefined,
      notes,
    });
  };

  walk(root);
  return steps;
}

/** Plan-derived findings, phrased in PostgreSQL's own vocabulary. */
export function planIssues(steps: PlanStep[]): Issue[] {
  const issues: Issue[] = [];

  for (const step of steps) {
    if (step.kind === "full_scan" && step.severity !== "none") {
      issues.push({
        code: "FULL_SCAN",
        severity: step.severity,
        title: `${step.table ?? "relation"}: sequential scan of ~${fmt(step.rows ?? 0)} rows`,
        detail:
          "PostgreSQL reads the whole relation. On a small table or a broad predicate this is the correct plan; if the query returns a small fraction of the rows, reduce the rows read before considering an index.",
        table: step.table,
      });
    }
    if (step.kind === "filesort" && step.severity === "critical") {
      issues.push({
        code: "FILESORT",
        severity: "critical",
        title: "Sort spilled to disk",
        detail:
          "The sort exceeded work_mem and was written to disk. Return fewer rows or sort on an index order before raising work_mem.",
        table: step.table,
      });
    }
  }

  return issues;
}

/**
 * Suggest indexes from the plan tree.
 *
 * MySQL derives these from its tabular EXPLAIN rows; PostgreSQL has no such
 * table, so the same reasoning runs over the plan steps instead. The rule is
 * unchanged and deliberately modest: suggest only when a step shows a scan or a
 * sort and the SQL names a column that would remove it. Equality columns come
 * first, then the sort column, which is the shape that lets one index satisfy
 * both the filter and the ORDER BY.
 */
export function suggestIndexes(
  sql: string,
  steps: PlanStep[],
  indexesByTable: Map<string, IndexInfo[]>,
): IndexSuggestion[] {
  const suggestions: IndexSuggestion[] = [];
  const seen = new Set<string>();

  // A Sort node carries no relation name, so pair it with the table the plan
  // actually scanned; that is the table an ordered index would have to cover.
  const sorting = steps.some((s) => s.kind === "filesort");
  const scanned = steps.filter((s) => s.kind === "full_scan" && s.table);

  for (const step of scanned) {
    const table = step.table!;
    const equality = extractEqualityColumns(sql, table);
    const ordering = extractOrderColumns(sql);
    const columns = [...new Set([...equality, ...ordering])].slice(0, 3);
    if (columns.length === 0) continue;

    const key = `${table}:${columns.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const existing = indexesByTable.get(table) ?? [];
    const redundant = existing.some((idx) => columns.every((c, i) => idx.columns[i] === c));

    suggestions.push({
      table,
      columns,
      reason: sorting
        ? `The plan reads ~${fmt(step.rows ?? 0)} rows sequentially and then sorts them; an index in this order can serve both.`
        : `The plan reads ~${fmt(step.rows ?? 0)} rows sequentially; these columns appear in the WHERE clause.`,
      // CONCURRENTLY keeps an existing workload running while the index builds.
      ...indexDdlFor(SCHEMA).create(table, columns),
      confidence: equality.length > 0 ? "high" : "medium",
      tradeoffs: [
        "Adds storage and work to INSERT/UPDATE/DELETE.",
        "CREATE INDEX CONCURRENTLY takes longer, and a cancelled build leaves an INVALID index behind.",
        "Keep it only if the re-checked plan and your own measurements improve.",
        ...(redundant
          ? ["An existing index already covers this prefix; do not create a duplicate."]
          : []),
      ],
      redundant,
    });
  }

  return suggestions;
}

export interface ExplainOptions {
  analyze?: boolean | undefined;
}

/**
 * Run EXPLAIN inside a read-only transaction that is always rolled back.
 *
 * READ ONLY blocks DML, DDL, and writable CTEs even when ANALYZE actually
 * executes the statement, and the timeouts bound both runtime and lock waits.
 * This cannot prove a volatile user function has no external side effect, which
 * is why ANALYZE stays opt-in.
 *
 * Session-scoped state is the gap ROLLBACK does not close: `pg_advisory_lock()`
 * is an ordinary SELECT that acquires a lock living on the *connection*, not the
 * transaction, so it survives the rollback and would then ride a pooled
 * connection into later work. ANALYZE therefore ends by discarding that session
 * state, and destroys the connection rather than returning it if that fails.
 */
export async function runExplain(
  pool: Pool,
  sql: string,
  opts: ExplainOptions = {},
): Promise<ExplainPayload> {
  assertExplainable(sql);

  const client = await pool.connect();
  let poisoned = false;
  const started = performance.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${opts.analyze ? 5000 : 3000}ms'`);
    await client.query("SET LOCAL lock_timeout = '1000ms'");

    const options = opts.analyze
      ? "ANALYZE TRUE, BUFFERS TRUE, TIMING FALSE, FORMAT JSON"
      : "COSTS TRUE, FORMAT JSON";
    const result = await client.query(`EXPLAIN (${options}) ${sql}`);

    const raw = result.rows[0]?.["QUERY PLAN"];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const root: PgPlanNode | undefined = Array.isArray(parsed) ? parsed[0]?.Plan : parsed?.Plan;

    // Without ANALYZE the plan reports rows emitted, not rows read, so a
    // filtered scan needs the relation's own size to be judged honestly.
    const relationRows = new Map<string, number>();
    const { rows: sizes } = await client.query(
      `SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND c.relkind IN ('r', 'p')`,
    );
    for (const row of sizes) relationRows.set(String(row.name), Number(row.rows));

    const steps = buildPlanSteps(root, relationRows);
    const rowsRead = steps.reduce((acc, s) => Math.max(acc, s.rows ?? 0), 0);

    return {
      sql,
      // PostgreSQL has no tabular EXPLAIN; the plan tree is the source of truth.
      rows: [],
      steps,
      issues: planIssues(steps),
      estimatedCost: Number(root?.["Total Cost"] ?? 0),
      json: parsed,
      analyze: opts.analyze ? JSON.stringify(parsed, null, 2) : null,
      elapsedMs: Math.round(performance.now() - started),
      advice: queryAdvice({
        digestText: sql,
        execCount: 1,
        totalTimeMs: 0,
        avgTimeMs: 0,
        rowsExamined: rowsRead,
        rowsSent: Number(root?.["Plan Rows"] ?? 0),
      }),
      suggestions: [],
    };
  } finally {
    // Roll back on both paths: an EXPLAIN ANALYZE must never commit.
    await client.query("ROLLBACK").catch(() => {});

    if (opts.analyze) {
      // The statement really ran, so clear anything it left on the session:
      // advisory locks, prepared statements, temp tables, and changed settings.
      try {
        await client.query("SELECT pg_advisory_unlock_all()");
        await client.query("DISCARD ALL");
      } catch {
        poisoned = true;
      }
    }

    // A connection whose session state could not be cleared must not go back
    // into the pool; releasing with an error destroys it instead.
    client.release(poisoned ? new Error("session state could not be reset") : undefined);
  }
}
