import type { Pool, RowDataPacket } from "mysql2/promise";
import type { QueryStat } from "#shared/types.ts";
import { queryIssues, rankQueries, tablesInQuery } from "../../core/rules.ts";
import { adviceIssues, queryAdvice } from "../../core/advice.ts";

/**
 * performance_schema reports times in picoseconds. Everything the UI shows is
 * milliseconds, so the conversion happens once, here.
 */
const PS_TO_MS = 1e9;

/**
 * Statements that tell us nothing about the application's own load.
 *
 * DDL is included deliberately: an ALTER TABLE issued from this very tool takes
 * seconds and would otherwise sit at the top of the impact ranking, burying the
 * application queries the ranking exists to surface.
 */
const NOISE =
  /^(SHOW|SET|EXPLAIN|ANALYZE|COMMIT|ROLLBACK|BEGIN|FLUSH|USE|SELECT @@|DESCRIBE|DESC |ALTER|CREATE|DROP|TRUNCATE|OPTIMIZE|CALL|GRANT|REVOKE)\b/i;

export async function fetchQueryStats(
  pool: Pool,
  schema: string,
  knownTables: string[],
  limit = 100,
): Promise<QueryStat[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, MAX_TIMER_WAIT,
            SUM_ROWS_SENT, SUM_ROWS_EXAMINED, SUM_NO_INDEX_USED,
            SUM_NO_GOOD_INDEX_USED, SUM_CREATED_TMP_TABLES,
            SUM_CREATED_TMP_DISK_TABLES, SUM_SORT_MERGE_PASSES,
            FIRST_SEEN, LAST_SEEN
       FROM performance_schema.events_statements_summary_by_digest
      WHERE SCHEMA_NAME = ?
      ORDER BY SUM_TIMER_WAIT DESC
      LIMIT ?`,
    [schema, limit],
  );

  const stats: QueryStat[] = [];
  for (const r of rows) {
    const digestText = String(r.DIGEST_TEXT ?? "");
    if (!digestText || NOISE.test(digestText.trim())) continue;
    // Our own introspection queries must not appear as application load.
    if (/information_schema|performance_schema/i.test(digestText)) continue;

    const execCount = Number(r.COUNT_STAR ?? 0);
    const totalTimeMs = Number(r.SUM_TIMER_WAIT ?? 0) / PS_TO_MS;
    const rowsSent = Number(r.SUM_ROWS_SENT ?? 0);
    const rowsExamined = Number(r.SUM_ROWS_EXAMINED ?? 0);

    const base = {
      digestText,
      rowsExamined,
      rowsSent,
      noIndexUsed: Number(r.SUM_NO_INDEX_USED ?? 0),
      createdTmpDiskTables: Number(r.SUM_CREATED_TMP_DISK_TABLES ?? 0),
      sortMergePasses: Number(r.SUM_SORT_MERGE_PASSES ?? 0),
      execCount,
    };

    const advice = queryAdvice({
      digestText,
      execCount,
      totalTimeMs,
      avgTimeMs: execCount > 0 ? totalTimeMs / execCount : 0,
      rowsExamined,
      rowsSent,
    });

    stats.push({
      digest: String(r.DIGEST ?? ""),
      sample: digestText,
      digestText,
      execCount,
      totalTimeMs,
      avgTimeMs: execCount > 0 ? totalTimeMs / execCount : 0,
      maxTimeMs: Number(r.MAX_TIMER_WAIT ?? 0) / PS_TO_MS,
      rowsSent,
      rowsExamined,
      examinedPerSent: rowsSent > 0 ? rowsExamined / rowsSent : rowsExamined,
      noIndexUsed: base.noIndexUsed,
      noGoodIndexUsed: Number(r.SUM_NO_GOOD_INDEX_USED ?? 0),
      createdTmpTables: Number(r.SUM_CREATED_TMP_TABLES ?? 0),
      createdTmpDiskTables: base.createdTmpDiskTables,
      sortMergePasses: base.sortMergePasses,
      tables: tablesInQuery(digestText, knownTables),
      firstSeen: r.FIRST_SEEN ? String(r.FIRST_SEEN) : null,
      lastSeen: r.LAST_SEEN ? String(r.LAST_SEEN) : null,
      impact: 0,
      advice,
      issues: [...adviceIssues(advice), ...queryIssues(base)],
    });
  }

  return rankQueries(stats);
}
