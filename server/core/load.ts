import type { QueryStat, TableLoad } from "#shared/types.ts";

/** One table as either engine's catalog reports it, before any rules run. */
export interface RawTable {
  name: string;
  engine: string;
  rows: number;
  dataBytes: number;
  indexBytes: number;
  comment: string;
}

/** Fold per-query statistics into per-table load for the Overview. */
export function aggregateLoad(stats: QueryStat[]): Map<string, TableLoad> {
  const byTable = new Map<string, TableLoad>();

  for (const q of stats) {
    // A query touching three tables is attributed to all three. Splitting the
    // time between them would imply precision we do not have.
    for (const table of q.tables) {
      const cur = byTable.get(table) ?? {
        queryCount: 0,
        execCount: 0,
        totalTimeMs: 0,
        avgTimeMs: 0,
        rowsExamined: 0,
        fullScanCount: 0,
      };
      cur.queryCount += 1;
      cur.execCount += q.execCount;
      cur.totalTimeMs += q.totalTimeMs;
      cur.rowsExamined += q.rowsExamined;
      cur.fullScanCount += q.noIndexUsed;
      cur.avgTimeMs = cur.execCount > 0 ? cur.totalTimeMs / cur.execCount : 0;
      byTable.set(table, cur);
    }
  }

  return byTable;
}
