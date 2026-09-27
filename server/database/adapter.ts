import type { Pool as MySqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";
import type {
  ConnectRequest,
  CreateIndexRequest,
  DataFilter,
  DataPage,
  DatabaseEngine,
  ExplainPayload,
  IndexInfo,
  IndexMutationResult,
  OverviewPayload,
  PerfSchemaStatus,
  QueryStat,
  SessionInfo,
  TableDetailPayload,
} from "#shared/types.ts";

/**
 * The seam between DBSCOPE and a specific database.
 *
 * Everything engine-specific — catalog queries, statistics sources, plan
 * vocabulary, DDL syntax and its safety rules — lives behind this interface.
 * The HTTP API, the shared rules, and the UI are written against the payload
 * types in `shared/types.ts` and never against a driver.
 *
 * Adding an engine means implementing this interface and registering it in
 * `registry.ts`. Nothing else should need to change.
 */

/**
 * The driver's own pool type. Adapters cast this back to their concrete pool;
 * the union exists so a session can hold either without the rest of the server
 * knowing which.
 */
export type DatabasePool = MySqlPool | PgPool;

export interface PageOptions {
  page?: number;
  pageSize?: number;
  orderBy?: string | null;
  orderDir?: "asc" | "desc";
  filter?: DataFilter | null;
}

/** What a successful handshake tells us about the server. */
export interface AdapterProbe {
  version: string;
  majorVersion: number;
  supportsExplainAnalyze: boolean;
  /**
   * Whether cumulative query statistics are actually readable, and why not when
   * they are not. Statistics are always optional: every view must still render
   * without them.
   */
  queryStats: PerfSchemaStatus;
}

export interface ExplainOptions {
  /** Opt-in, because ANALYZE really executes the statement. */
  analyze?: boolean | undefined;
  supportsAnalyze?: boolean | undefined;
}

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  /** Used when the connect form leaves the port blank. */
  readonly defaultPort: number;

  createPool(req: ConnectRequest, endpoint: { host: string; port: number }): DatabasePool;
  probe(pool: DatabasePool): Promise<AdapterProbe>;
  close(pool: DatabasePool): Promise<void>;

  overview(pool: DatabasePool, info: SessionInfo): Promise<OverviewPayload>;
  tableDetail(pool: DatabasePool, info: SessionInfo, table: string): Promise<TableDetailPayload>;
  fetchPage(
    pool: DatabasePool,
    database: string,
    table: string,
    opts: PageOptions,
  ): Promise<DataPage>;
  listIndexes(pool: DatabasePool, database: string, table: string): Promise<IndexInfo[]>;

  /** Returns an empty list rather than throwing when statistics are unavailable. */
  queryStats(
    pool: DatabasePool,
    database: string,
    tableNames: string[],
    limit: number,
  ): Promise<QueryStat[]>;
  resetQueryStats(pool: DatabasePool): Promise<void>;

  explain(
    pool: DatabasePool,
    database: string,
    sql: string,
    opts: ExplainOptions,
  ): Promise<ExplainPayload>;

  /** The only writes DBSCOPE performs. Both must refuse to touch constraints. */
  createIndex(
    pool: DatabasePool,
    database: string,
    req: CreateIndexRequest,
  ): Promise<IndexMutationResult>;
  dropIndex(
    pool: DatabasePool,
    database: string,
    table: string,
    name: string,
  ): Promise<IndexMutationResult>;
}
