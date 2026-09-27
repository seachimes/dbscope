import type { Pool } from "pg";
import type { PerfSchemaStatus, QueryStat } from "#shared/types.ts";
import { adviceIssues, queryAdvice } from "../../core/advice.ts";
import { rankQueries, tablesInQuery } from "../../core/rules.ts";
import { toNumber } from "./sql.ts";

/**
 * pg_stat_statements is an extension, not a built-in view, and it must also be
 * in shared_preload_libraries. Probing the catalog tells us whether statistics
 * are genuinely readable instead of guessing from configuration flags.
 */
export async function probeQueryStats(pool: Pool): Promise<PerfSchemaStatus> {
  const { rows } = await pool.query(
    `SELECT n.nspname AS schema
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'`,
  );
  const schema = rows[0]?.schema ? String(rows[0].schema) : null;
  if (!schema) {
    return {
      enabled: false,
      digestEnabled: false,
      reason:
        "pg_stat_statements is not installed. Add it to shared_preload_libraries, restart PostgreSQL, and run CREATE EXTENSION pg_stat_statements; DBSCOPE falls back to schema and plan analysis until then.",
    };
  }

  try {
    await pool.query(`SELECT 1 FROM ${quoteSchema(schema)}.pg_stat_statements LIMIT 1`);
    return { enabled: true, digestEnabled: true };
  } catch (err) {
    return {
      enabled: true,
      digestEnabled: false,
      reason: `pg_stat_statements is installed but not readable by this user: ${(err as Error).message}`,
    };
  }
}

function quoteSchema(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error(`unsafe schema: ${schema}`);
  return `"${schema}"`;
}

/**
 * Rank statements by share of total execution time.
 *
 * pg_stat_statements reports `rows` returned; unlike performance_schema it has
 * no notion of rows examined or "no index used". Those fields are reported as
 * 0 rather than invented, and PostgreSQL bottlenecks are detected from the plan
 * instead.
 */
export async function fetchQueryStats(
  pool: Pool,
  tableNames: string[],
  limit = 100,
): Promise<QueryStat[]> {
  const stats = await probeQueryStats(pool);
  if (!stats.digestEnabled) return [];

  const { rows: ext } = await pool.query(
    `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'`,
  );
  const schema = quoteSchema(String(ext[0]?.schema ?? "public"));

  const { rows } = await pool.query(
    `SELECT queryid::text AS digest,
            query AS digest_text,
            calls,
            total_exec_time,
            mean_exec_time,
            max_exec_time,
            rows,
            temp_blks_written
       FROM ${schema}.pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND calls > 0
        AND query IS NOT NULL
        AND query ~* '^\\s*(select|with)\\s'
      ORDER BY total_exec_time DESC
      LIMIT $1`,
    [limit],
  );

  return rankQueries(
    rows.map((r) => {
      const digestText = String(r.digest_text);
      const execCount = toNumber(r.calls);
      const totalTimeMs = toNumber(r.total_exec_time);
      const avgTimeMs = toNumber(r.mean_exec_time);
      const rowsSent = toNumber(r.rows);
      const advice = queryAdvice({
        digestText,
        execCount,
        totalTimeMs,
        avgTimeMs,
        rowsExamined: rowsSent,
        rowsSent,
      });

      return {
        digest: String(r.digest),
        sample: digestText,
        digestText,
        execCount,
        totalTimeMs,
        avgTimeMs,
        maxTimeMs: toNumber(r.max_exec_time),
        rowsSent,
        // pg_stat_statements cannot report rows examined; see the note above.
        rowsExamined: rowsSent,
        examinedPerSent: 1,
        noIndexUsed: 0,
        noGoodIndexUsed: 0,
        createdTmpTables: 0,
        createdTmpDiskTables: toNumber(r.temp_blks_written) > 0 ? 1 : 0,
        sortMergePasses: 0,
        tables: tablesInQuery(digestText, tableNames),
        firstSeen: null,
        lastSeen: null,
        impact: 0,
        advice,
        issues: adviceIssues(advice),
      } satisfies QueryStat;
    }),
  );
}

/**
 * Reset only this database's statistics.
 *
 * The no-argument form resets the entire cluster, which would silently discard
 * other databases' data, so it is not used as a fallback.
 */
export async function resetQueryStats(pool: Pool): Promise<void> {
  const { rows: ext } = await pool.query(
    `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements'`,
  );
  if (!ext[0]?.schema) throw new Error("pg_stat_statements is not installed");
  const schema = quoteSchema(String(ext[0].schema));

  await pool.query(
    `SELECT ${schema}.pg_stat_statements_reset(
       0::oid,
       (SELECT oid FROM pg_database WHERE datname = current_database()),
       0::bigint
     )`,
  );
}
