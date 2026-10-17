import type {
  ColumnInfo,
  ExplainRow,
  IndexInfo,
  Issue,
  QueryStat,
  RelationInfo,
} from "#shared/types.ts";
import type { RawTable } from "./load.ts";

/**
 * Rule-based detection. Every rule here answers one question: "would a strong
 * operator stop and look at this?" Anything that would merely be *tidier* is
 * left out because diagnostic noise slows investigation.
 */

/** A table is "big" once a scan of it is a real cost. */
const BIG_ROWS = 10_000;
const HUGE_ROWS = 100_000;

/**
 * The engine's own DDL, so a suggestion is the statement DBSCOPE would run and
 * can be copied into a schema file unchanged.
 */
export interface IndexDdl {
  create(table: string, columns: string[]): Statements;
  drop(table: string, index: string): Statements;
}

/**
 * What DBSCOPE runs, and the portable form for the project's SQL files. Both
 * end in a semicolon so they paste as-is; the driver is sent one statement
 * without it.
 */
export interface Statements {
  ddl: string;
  fileDdl: string;
}

function suggest(statements: Statements): Pick<Issue, "suggestion" | "fileSuggestion"> {
  return { suggestion: statements.ddl, fileSuggestion: statements.fileDdl };
}

export function tableIssues(
  table: RawTable,
  columns: ColumnInfo[],
  indexes: IndexInfo[],
  relations: RelationInfo[],
  ddl: IndexDdl,
): Issue[] {
  const issues: Issue[] = [];
  const secondary = indexes.filter((i) => !i.isPrimary);
  const hasPk = indexes.some((i) => i.isPrimary);

  if (!hasPk) {
    issues.push({
      code: "NO_PRIMARY_KEY",
      severity: "critical",
      title: `${table.name} has no PRIMARY KEY`,
      detail:
        "InnoDB will use a hidden clustered index. Replication and range access both suffer, and every secondary index grows.",
      table: table.name,
    });
  }

  if (table.rows >= BIG_ROWS && secondary.length === 0) {
    issues.push({
      code: "LOW_INDEX_COVERAGE",
      severity: table.rows >= HUGE_ROWS ? "critical" : "warning",
      title: `${table.name} has ${fmt(table.rows)} rows but no secondary index`,
      detail:
        "Any WHERE or ORDER BY that is not on the primary key must scan the whole table. This is usually the first thing to fix.",
      table: table.name,
    });
  }

  // An unindexed FK column is a join that scans. Report it per column so the
  // suggested DDL is directly runnable.
  for (const rel of relations) {
    if (rel.fromTable !== table.name || !rel.unindexed) continue;
    issues.push({
      code: "UNINDEXED_FK",
      severity: table.rows >= BIG_ROWS ? "critical" : "warning",
      title: `${table.name}.${rel.fromColumn} → ${rel.toTable} has no index`,
      detail:
        `Joining or filtering on ${rel.fromColumn} scans all ${fmt(table.rows)} rows. ` +
        (rel.kind === "inferred"
          ? "This relation was inferred from the column name, not a declared FK."
          : "This is a declared foreign key."),
      table: table.name,
      columns: [rel.fromColumn],
      ...suggest(ddl.create(table.name, [rel.fromColumn])),
    });
  }

  // Columns people sort and filter by constantly, left unindexed on a big table.
  if (table.rows >= BIG_ROWS) {
    for (const col of columns) {
      const lower = col.name.toLowerCase();
      const isTimeish =
        /^(created_at|updated_at|posted_at|timestamp|date)$/.test(lower) ||
        col.dataType === "timestamp" ||
        col.dataType === "datetime";
      if (!isTimeish) continue;
      const indexed = indexes.some((i) => i.columns[0] === col.name);
      if (indexed) continue;

      issues.push({
        code: "FILESORT",
        severity: "warning",
        title: `${table.name}.${col.name} is unindexed and likely sorted on`,
        detail:
          "Timeline-style queries (ORDER BY ... DESC LIMIT n) on this column will sort the whole table before returning a handful of rows.",
        table: table.name,
        columns: [col.name],
        ...suggest(ddl.create(table.name, [col.name])),
      });
    }
  }

  // Redundant index: one whose columns are a prefix of another. Costs writes
  // and buffer pool for nothing.
  for (const a of secondary) {
    // A UNIQUE index is also a data-integrity constraint; a wider non-unique
    // prefix never makes it redundant.
    if (a.unique) continue;
    for (const b of indexes) {
      if (a.name === b.name) continue;
      if (a.columns.length >= b.columns.length) continue;
      const isPrefix = a.columns.every((c, i) => b.columns[i] === c);
      if (!isPrefix) continue;
      issues.push({
        code: "NO_INDEX",
        severity: "info",
        title: `${table.name}.${a.name} is redundant`,
        detail: `(${a.columns.join(", ")}) is a prefix of ${b.name} (${b.columns.join(", ")}). Dropping it speeds up writes.`,
        table: table.name,
        columns: a.columns,
        ...suggest(ddl.drop(table.name, a.name)),
      });
    }
  }

  return issues;
}

/**
 * Heat: a 0..100 score blending size and measured load, used for node size and
 * color in the Overview. Size alone is misleading (a big table nobody queries
 * is fine) and load alone hides the tables that are about to become a problem,
 * so both feed in.
 */
export function computeHeat(
  table: RawTable,
  issues: Issue[],
  loadShare: number,
  maxRows: number,
): number {
  const sizeScore = maxRows > 0 ? Math.sqrt(table.rows / maxRows) : 0;
  const severityScore = issues.reduce((acc, i) => {
    if (i.severity === "critical") return acc + 0.34;
    if (i.severity === "warning") return acc + 0.15;
    return acc + 0.03;
  }, 0);

  // Measured load dominates when present; it is evidence rather than a guess.
  const score = loadShare * 0.5 + Math.min(severityScore, 1) * 0.3 + sizeScore * 0.2;
  return Math.round(Math.min(score, 1) * 100);
}

// --------------------------------------------------------------- query rules

export function queryIssues(q: {
  digestText: string;
  rowsExamined: number;
  rowsSent: number;
  noIndexUsed: number;
  createdTmpDiskTables: number;
  sortMergePasses: number;
  execCount: number;
}): Issue[] {
  const issues: Issue[] = [];
  const ratio = q.rowsSent > 0 ? q.rowsExamined / q.rowsSent : q.rowsExamined;

  if (q.noIndexUsed > 0) {
    issues.push({
      code: "FULL_SCAN",
      severity: "critical",
      title: `Runs without an index (${fmt(q.noIndexUsed)} of ${fmt(q.execCount)} executions)`,
      detail:
        "MySQL reported no index was used. Inspect EXPLAIN and the query shape: an index may help, but batching, a sargable predicate, or fetching fewer rows can be the better fix.",
    });
  }

  // Reading a hundred rows to return one is the clearest sign of a bad plan.
  if (ratio >= 100 && q.rowsExamined > 1000) {
    issues.push({
      code: "HUGE_ROWS",
      severity: ratio >= 1000 ? "critical" : "warning",
      title: `Examines ${Math.round(ratio)}× more rows than it returns`,
      detail: `${fmt(q.rowsExamined)} rows read to produce ${fmt(q.rowsSent)}. The filter is being applied after reading, not during.`,
    });
  }

  if (q.createdTmpDiskTables > 0) {
    issues.push({
      code: "TEMPORARY",
      severity: "critical",
      title: `Creates on-disk temporary tables (${fmt(q.createdTmpDiskTables)}×)`,
      detail:
        "A temporary table spilled to disk. Usually caused by GROUP BY / DISTINCT on an unindexed column, or by a TEXT column in the result.",
    });
  }

  if (q.sortMergePasses > 0) {
    issues.push({
      code: "FILESORT",
      severity: "warning",
      title: `Sorts on disk (${fmt(q.sortMergePasses)} merge passes)`,
      detail:
        "The sort buffer was too small, so sorting spilled to disk. An index in sort order removes the sort entirely.",
    });
  }

  if (/^SELECT\s+\*/i.test(q.digestText.trim())) {
    issues.push({
      code: "SELECT_STAR",
      severity: "info",
      title: "Selects every column",
      detail:
        "SELECT * prevents covering-index optimizations and moves TEXT/BLOB data you may not need.",
    });
  }

  return issues;
}

/** Extract table names from a normalized digest. Good enough to link queries to tables. */
export function tablesInQuery(digestText: string, known: string[]): string[] {
  const found = new Set<string>();
  const lower = digestText.toLowerCase();
  for (const table of known) {
    // Match the identifier on a word/backtick boundary to avoid `post` hitting `posts`.
    const re = new RegExp(`(^|[^\\w\`])\`?${escapeRe(table.toLowerCase())}\`?($|[^\\w])`);
    if (re.test(lower)) found.add(table);
  }
  return [...found];
}

// ------------------------------------------------------------- explain rules

export function explainIssues(rows: ExplainRow[]): Issue[] {
  const issues: Issue[] = [];

  for (const row of rows) {
    const table = row.table ?? undefined;
    const extra = row.extra ?? "";

    if (row.type === "ALL") {
      issues.push({
        code: "FULL_SCAN",
        severity: (row.rows ?? 0) > BIG_ROWS ? "critical" : "warning",
        title: `${table ?? "table"}: full table scan (type = ALL)`,
        detail: `Every one of ~${fmt(row.rows ?? 0)} rows is read. If a WHERE clause filters this table, an index on that column removes the scan.`,
        table,
      });
    }

    if (row.key === null && row.type !== null && row.type !== "ALL") {
      issues.push({
        code: "NO_INDEX",
        severity: "warning",
        title: `${table ?? "table"}: no index chosen (key = NULL)`,
        detail: row.possibleKeys
          ? `Candidates existed (${row.possibleKeys}) but none was used. The column may be wrapped in a function, or the types may not match.`
          : "No candidate index exists for this access.",
        table,
      });
    }

    if ((row.rows ?? 0) >= HUGE_ROWS) {
      issues.push({
        code: "HUGE_ROWS",
        severity: "critical",
        title: `${table ?? "table"}: ~${fmt(row.rows ?? 0)} rows estimated`,
        detail: "The planner expects to touch a very large number of rows at this step.",
        table,
      });
    }

    if (/Using filesort/i.test(extra)) {
      issues.push({
        code: "FILESORT",
        severity: "warning",
        title: `${table ?? "table"}: Using filesort`,
        detail:
          "Results are sorted after reading. An index whose order matches the ORDER BY lets MySQL skip the sort and stop early at LIMIT.",
        table,
      });
    }

    if (/Using temporary/i.test(extra)) {
      issues.push({
        code: "TEMPORARY",
        severity: "warning",
        title: `${table ?? "table"}: Using temporary`,
        detail:
          "A temporary table is materialized, typically for GROUP BY or DISTINCT on an unindexed expression.",
        table,
      });
    }
  }

  return dedupe(issues);
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}|${i.table ?? ""}|${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rankQueries(stats: QueryStat[]): QueryStat[] {
  const totalTime = stats.reduce((a, q) => a + q.totalTimeMs, 0);
  return stats
    .map((q) => ({
      ...q,
      // Impact = share of total observed execution time:
      // not "which query is slow" but "where is the time actually going".
      impact: totalTime > 0 ? Math.round((q.totalTimeMs / totalTime) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.totalTimeMs - a.totalTimeMs);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}
