import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { PerfSchemaStatus } from "#shared/types.ts";
import type { DatabaseAdapter, DatabasePool } from "../adapter.ts";
import { buildOverview, buildTableDetail } from "./overview.ts";
import { createIndex, dropIndex, fetchPage, listIndexes } from "./data.ts";
import { fetchQueryStats } from "./queries.ts";
import { fetchIndexes } from "./introspect.ts";
import { runExplain, suggestIndexes } from "./explain.ts";

const asPool = (pool: DatabasePool): Pool => pool as Pool;

/**
 * EXPLAIN ANALYZE landed in MySQL 8.0.18. MariaDB reports 10.x/11.x and has its
 * own ANALYZE syntax, so support is not claimed there.
 */
function parseVersion(raw: string): { major: number; analyze: boolean } {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return { major: 0, analyze: false };

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const analyze = major > 8 || (major === 8 && (minor > 0 || (minor === 0 && patch >= 18)));

  return { major, analyze: analyze && !/mariadb/i.test(raw) };
}

/**
 * Being able to read the digest table matters more than the flags saying yes,
 * so the probe ends with an actual read.
 */
async function probeQueryStats(pool: Pool): Promise<PerfSchemaStatus> {
  try {
    const [vars] = await pool.query<RowDataPacket[]>("SHOW VARIABLES LIKE 'performance_schema'");
    if (vars[0]?.Value !== "ON") {
      return {
        enabled: false,
        digestEnabled: false,
        reason:
          "performance_schema=OFF. Query statistics are unavailable; add performance_schema=ON to my.cnf and restart MySQL. DBSCOPE falls back to schema and plan analysis until then.",
      };
    }

    const [consumers] = await pool.query<RowDataPacket[]>(
      "SELECT ENABLED FROM performance_schema.setup_consumers WHERE NAME = 'statements_digest'",
    );
    if (consumers[0]?.ENABLED !== "YES") {
      return {
        enabled: true,
        digestEnabled: false,
        reason:
          "The statements_digest consumer is OFF. Enable it with: UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='statements_digest';",
      };
    }

    await pool.query(
      "SELECT 1 FROM performance_schema.events_statements_summary_by_digest LIMIT 1",
    );
    return { enabled: true, digestEnabled: true };
  } catch (err) {
    return {
      enabled: false,
      digestEnabled: false,
      reason: `performance_schema is not readable by this user: ${(err as Error).message}`,
    };
  }
}

export const mysqlAdapter: DatabaseAdapter = {
  engine: "mysql",
  defaultPort: 3306,

  createPool(req, endpoint) {
    return mysql.createPool({
      host: endpoint.host,
      port: endpoint.port,
      user: req.mysql.user,
      password: req.mysql.password,
      database: req.mysql.database,
      waitForConnections: true,
      // Deliberately small: a diagnostic tool must not become load itself.
      connectionLimit: 4,
      // Reject bursts instead of accumulating stale work against a live database.
      queueLimit: 8,
      maxIdle: 2,
      idleTimeout: 30_000,
      connectTimeout: 15_000,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
      multipleStatements: false,
      timezone: "Z",
    });
  },

  async probe(pool) {
    const client = asPool(pool);
    const [rows] = await client.query<RowDataPacket[]>("SELECT VERSION() AS version");
    const version = String(rows[0]?.version ?? "");
    const { major, analyze } = parseVersion(version);

    return {
      version,
      majorVersion: major,
      supportsExplainAnalyze: analyze,
      queryStats: await probeQueryStats(client),
    };
  },

  async close(pool) {
    await asPool(pool).end();
  },

  overview: (pool, info) => buildOverview(asPool(pool), info),

  tableDetail: (pool, info, table) => buildTableDetail(asPool(pool), info, table),

  fetchPage: (pool, database, table, opts) => fetchPage(asPool(pool), database, table, opts),

  listIndexes: (pool, database, table) => listIndexes(asPool(pool), database, table),

  queryStats: (pool, database, tableNames, limit) =>
    fetchQueryStats(asPool(pool), database, tableNames, limit),

  resetQueryStats: async () => {
    throw new Error(
      "MySQL statistics cannot be reset for one database without clearing server-wide counters",
    );
  },

  async explain(pool, database, sql, opts) {
    const client = asPool(pool);
    const payload = await runExplain(client, sql, opts);
    // Suggestions need the existing indexes so an already-covered column is not
    // recommended again.
    payload.suggestions = suggestIndexes(payload, await fetchIndexes(client, database));
    return payload;
  },

  createIndex: (pool, database, request) => createIndex(asPool(pool), database, request),

  dropIndex: (pool, database, table, name) => dropIndex(asPool(pool), database, table, name),
};
