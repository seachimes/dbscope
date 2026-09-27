import type { Pool } from "mysql2/promise";
import type {
  OverviewPayload,
  SessionInfo,
  TableDetailPayload,
  TableSummary,
} from "#shared/types.ts";
import {
  fetchColumns,
  fetchCreateStatement,
  fetchIndexes,
  fetchRelations,
  fetchTables,
} from "./introspect.ts";
import { fetchQueryStats } from "./queries.ts";
import { aggregateLoad } from "../../core/load.ts";
import { computeHeat, tableIssues } from "../../core/rules.ts";

/**
 * Build the whole Overview in one pass. The UI asks once and gets everything
 * it needs to draw: this keeps the "open it and see the problem" experience
 * to a single round trip.
 */
export async function buildOverview(pool: Pool, info: SessionInfo): Promise<OverviewPayload> {
  const schema = info.database;

  const [tables, columns, indexes] = await Promise.all([
    fetchTables(pool, schema),
    fetchColumns(pool, schema),
    fetchIndexes(pool, schema),
  ]);

  const relations = await fetchRelations(pool, schema, tables, columns, indexes);
  const tableNames = tables.map((t) => t.name);

  // Query statistics are a bonus, never a requirement. A database with
  // performance_schema off must still render a complete Overview.
  let stats: Awaited<ReturnType<typeof fetchQueryStats>> = [];
  if (info.performanceSchema.digestEnabled) {
    stats = await fetchQueryStats(pool, schema, tableNames).catch(() => []);
  }
  const loadByTable = aggregateLoad(stats);
  const maxLoadTime = Math.max(1, ...[...loadByTable.values()].map((l) => l.totalTimeMs));
  const maxRows = Math.max(1, ...tables.map((t) => t.rows));

  const summaries: TableSummary[] = tables.map((table) => {
    const cols = columns.get(table.name) ?? [];
    const idx = indexes.get(table.name) ?? [];
    const issues = tableIssues(table, cols, idx, relations);
    const load = loadByTable.get(table.name) ?? null;
    const loadShare = load ? load.totalTimeMs / maxLoadTime : 0;

    return {
      name: table.name,
      engine: table.engine,
      rows: table.rows,
      dataBytes: table.dataBytes,
      indexBytes: table.indexBytes,
      totalBytes: table.dataBytes + table.indexBytes,
      indexCount: idx.filter((i) => !i.isPrimary).length,
      columnCount: cols.length,
      hasPrimaryKey: idx.some((i) => i.isPrimary),
      comment: table.comment,
      load,
      issues,
      heat: computeHeat(table, issues, loadShare, maxRows),
    };
  });

  const allIssues = summaries
    .flatMap((s) => s.issues)
    .sort((a, b) => weight(b.severity) - weight(a.severity));

  return {
    database: schema,
    generatedAt: new Date().toISOString(),
    tables: summaries,
    relations,
    totals: {
      tableCount: summaries.length,
      rowCount: summaries.reduce((a, t) => a + t.rows, 0),
      dataBytes: summaries.reduce((a, t) => a + t.dataBytes, 0),
      indexBytes: summaries.reduce((a, t) => a + t.indexBytes, 0),
    },
    issues: allIssues,
    perfSchema: info.performanceSchema,
  };
}

export async function buildTableDetail(
  pool: Pool,
  info: SessionInfo,
  tableName: string,
): Promise<TableDetailPayload> {
  const schema = info.database;

  const [tables, columns, indexes] = await Promise.all([
    fetchTables(pool, schema),
    fetchColumns(pool, schema),
    fetchIndexes(pool, schema),
  ]);

  const table = tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`unknown table: ${tableName}`);

  const relations = await fetchRelations(pool, schema, tables, columns, indexes);
  const cols = columns.get(tableName) ?? [];
  const idx = indexes.get(tableName) ?? [];
  const issues = tableIssues(table, cols, idx, relations);

  let queries: Awaited<ReturnType<typeof fetchQueryStats>> = [];
  if (info.performanceSchema.digestEnabled) {
    const all = await fetchQueryStats(
      pool,
      schema,
      tables.map((t) => t.name),
    ).catch(() => []);
    queries = all.filter((q) => q.tables.includes(tableName));
  }

  const load = aggregateLoad(queries).get(tableName) ?? null;
  const maxRows = Math.max(1, ...tables.map((t) => t.rows));

  const summary: TableSummary = {
    name: table.name,
    engine: table.engine,
    rows: table.rows,
    dataBytes: table.dataBytes,
    indexBytes: table.indexBytes,
    totalBytes: table.dataBytes + table.indexBytes,
    indexCount: idx.filter((i) => !i.isPrimary).length,
    columnCount: cols.length,
    hasPrimaryKey: idx.some((i) => i.isPrimary),
    comment: table.comment,
    load,
    issues,
    heat: computeHeat(table, issues, load ? 1 : 0, maxRows),
  };

  return {
    name: tableName,
    summary,
    columns: cols,
    indexes: idx,
    createStatement: await fetchCreateStatement(pool, tableName),
    // Both directions: what this table points at, and what points at it.
    relations: relations.filter((r) => r.fromTable === tableName || r.toTable === tableName),
    queries,
    issues,
  };
}

function weight(severity: string): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
}
