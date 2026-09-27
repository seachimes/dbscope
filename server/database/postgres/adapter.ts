import { Pool } from "pg";
import type {
  ColumnInfo,
  IndexInfo,
  OverviewPayload,
  QueryStat,
  RelationInfo,
  TableDetailPayload,
  TableSummary,
} from "#shared/types.ts";
import type { DatabaseAdapter, DatabasePool } from "../adapter.ts";
import { aggregateLoad, type RawTable } from "../../core/load.ts";
import { computeHeat, tableIssues } from "../../core/rules.ts";
import {
  fetchColumns,
  fetchIndexes,
  fetchRelations,
  fetchTableDefinition,
  fetchTables,
} from "./introspect.ts";
import { fetchQueryStats, probeQueryStats, resetQueryStats } from "./queries.ts";
import { runExplain, suggestIndexes } from "./explain.ts";
import { createIndex, dropIndex, fetchPage } from "./data.ts";
import { toNumber } from "./sql.ts";

/**
 * PostgreSQL separates database from schema, where MySQL does not. DBSCOPE
 * inspects the default schema; a schema selector is the natural extension
 * point if multi-schema inspection is added.
 */
const SCHEMA = "public";

const asPool = (pool: DatabasePool): Pool => pool as Pool;

function buildSummaries(
  tables: RawTable[],
  columns: Map<string, ColumnInfo[]>,
  indexes: Map<string, IndexInfo[]>,
  relations: RelationInfo[],
  queries: QueryStat[],
): TableSummary[] {
  const loads = aggregateLoad(queries);
  const maxRows = Math.max(1, ...tables.map((t) => t.rows));
  const maxLoad = Math.max(1, ...[...loads.values()].map((l) => l.totalTimeMs));

  return tables.map((table) => {
    const cols = columns.get(table.name) ?? [];
    const idx = indexes.get(table.name) ?? [];
    const issues = tableIssues(table, cols, idx, relations);
    const load = loads.get(table.name) ?? null;

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
      heat: computeHeat(table, issues, load ? load.totalTimeMs / maxLoad : 0, maxRows),
    };
  });
}

export const postgresAdapter: DatabaseAdapter = {
  engine: "postgres",
  defaultPort: 5432,

  createPool(req, endpoint) {
    return new Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: req.mysql.user,
      password: req.mysql.password,
      database: req.mysql.database,
      // Deliberately small: a diagnostic tool must not become load itself.
      max: 4,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      application_name: "dbscope",
    });
  },

  async probe(pool) {
    const client = asPool(pool);
    const { rows } = await client.query("SELECT current_setting($1) AS version", [
      "server_version",
    ]);
    const version = String(rows[0]?.version ?? "");
    return {
      version,
      majorVersion: toNumber(version.split(".")[0]),
      // EXPLAIN ANALYZE has existed for far longer than any supported release.
      supportsExplainAnalyze: true,
      queryStats: await probeQueryStats(client),
    };
  },

  async close(pool) {
    await asPool(pool).end();
  },

  async overview(pool, info): Promise<OverviewPayload> {
    const client = asPool(pool);
    const [tables, columns, indexes] = await Promise.all([
      fetchTables(client, SCHEMA),
      fetchColumns(client, SCHEMA),
      fetchIndexes(client, SCHEMA),
    ]);
    const relations = await fetchRelations(client, SCHEMA, tables, columns, indexes);

    // Query statistics are a bonus, never a requirement.
    const queries = info.performanceSchema.digestEnabled
      ? await fetchQueryStats(
          client,
          tables.map((t) => t.name),
        ).catch(() => [])
      : [];

    const summaries = buildSummaries(tables, columns, indexes, relations, queries);

    return {
      database: info.database,
      generatedAt: new Date().toISOString(),
      tables: summaries,
      relations,
      totals: {
        tableCount: summaries.length,
        rowCount: summaries.reduce((acc, t) => acc + t.rows, 0),
        dataBytes: summaries.reduce((acc, t) => acc + t.dataBytes, 0),
        indexBytes: summaries.reduce((acc, t) => acc + t.indexBytes, 0),
      },
      issues: summaries.flatMap((s) => s.issues),
      perfSchema: info.performanceSchema,
    };
  },

  async tableDetail(pool, info, name): Promise<TableDetailPayload> {
    const client = asPool(pool);
    const [tables, columns, indexes] = await Promise.all([
      fetchTables(client, SCHEMA),
      fetchColumns(client, SCHEMA),
      fetchIndexes(client, SCHEMA),
    ]);

    const table = tables.find((t) => t.name === name);
    if (!table) throw new Error(`unknown table: ${name}`);

    const relations = await fetchRelations(client, SCHEMA, tables, columns, indexes);
    const queries = info.performanceSchema.digestEnabled
      ? (
          await fetchQueryStats(
            client,
            tables.map((t) => t.name),
          ).catch(() => [])
        ).filter((q) => q.tables.includes(name))
      : [];

    const summary = buildSummaries([table], columns, indexes, relations, queries)[0]!;
    const cols = columns.get(name) ?? [];

    return {
      name,
      summary,
      columns: cols,
      indexes: indexes.get(name) ?? [],
      createStatement: await fetchTableDefinition(client, SCHEMA, name, cols),
      relations: relations.filter((r) => r.fromTable === name || r.toTable === name),
      queries,
      issues: summary.issues,
    };
  },

  fetchPage: (pool, _database, table, opts) => fetchPage(asPool(pool), SCHEMA, table, opts),

  async listIndexes(pool, _database, table) {
    return (await fetchIndexes(asPool(pool), SCHEMA)).get(table) ?? [];
  },

  queryStats: (pool, _database, tableNames, limit) =>
    fetchQueryStats(asPool(pool), tableNames, limit),

  resetQueryStats: (pool) => resetQueryStats(asPool(pool)),

  async explain(pool, _database, sql, opts) {
    const client = asPool(pool);
    const payload = await runExplain(client, sql, { analyze: opts.analyze });
    // Existing indexes are needed so an already-covered prefix is marked
    // redundant rather than recommended again.
    payload.suggestions = suggestIndexes(sql, payload.steps, await fetchIndexes(client, SCHEMA));
    return payload;
  },

  createIndex: (pool, _database, request) => createIndex(asPool(pool), SCHEMA, request),

  dropIndex: (pool, _database, table, name) => dropIndex(asPool(pool), SCHEMA, table, name),
};
