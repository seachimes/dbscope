/**
 * The contract between server and UI. Everything the browser renders is
 * described here, so the visualization never has to guess at shapes.
 */

// ---------------------------------------------------------------- connection

export type DatabaseEngine = "mysql" | "postgres";

/**
 * How strictly the SSH host key is checked.
 *
 * - `known_hosts` (default): the key must already be trusted in the user's
 *   ~/.ssh/known_hosts. A mismatch is always fatal.
 * - `insecure`: accept any host key. Convenient for throwaway fixtures, and
 *   unsafe on any network where a machine-in-the-middle is possible.
 */
export type HostKeyPolicy = "known_hosts" | "insecure";

export interface ConnectRequest {
  engine?: DatabaseEngine;
  ssh: {
    host: string;
    port: number;
    user: string;
    /** PEM text, or an absolute path on the machine running DBSCOPE. */
    privateKey: string;
    passphrase?: string;
    /** Defaults to `known_hosts`. */
    hostKeyPolicy?: HostKeyPolicy;
  } | null;
  /** Kept as `mysql` for wire compatibility; represents the selected database connection. */
  mysql: {
    /** Host as resolved *from the VM*. Usually 127.0.0.1, "mysql", or "postgres". */
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

export interface SessionInfo {
  id: string;
  engine: DatabaseEngine;
  database: string;
  viaSsh: boolean;
  /** Server version; legacy field name retained for API compatibility. */
  mysqlVersion: string;
  majorVersion: number;
  /** EXPLAIN ANALYZE needs 8.0.18+. */
  supportsExplainAnalyze: boolean;
  performanceSchema: PerfSchemaStatus;
  connectedAt: string;
}

export interface PerfSchemaStatus {
  enabled: boolean;
  digestEnabled: boolean;
  /** Why it is unusable, when it is. Shown verbatim in the UI. */
  reason?: string | undefined;
}

// -------------------------------------------------------------------- schema

export interface ColumnInfo {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  key: string;
  defaultValue: string | null;
  extra: string;
  comment: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  type: string;
  /** Ordered by seq_in_index. */
  columns: string[];
  /** Estimated distinct values of the leftmost prefix; null when unknown. */
  cardinality: number | null;
  isPrimary: boolean;
  /**
   * False only for a PostgreSQL index left INVALID by a failed or cancelled
   * CREATE INDEX CONCURRENTLY: it still costs writes but cannot serve reads.
   * Undefined on engines where the concept does not exist.
   */
  valid?: boolean | undefined;
}

export interface RelationInfo {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** Declared FKs are certain; the rest are guessed from naming. */
  kind: "foreign_key" | "inferred";
  confidence: number;
  /** Set when the FK side has no usable index — a classic join killer. */
  unindexed: boolean;
}

export interface TableSummary {
  name: string;
  engine: string;
  /** InnoDB's estimate. Approximate by nature, and labeled as such in the UI. */
  rows: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
  indexCount: number;
  columnCount: number;
  hasPrimaryKey: boolean;
  comment: string;
  /** Aggregated from performance_schema, when available. */
  load: TableLoad | null;
  issues: Issue[];
  /** 0..100. Drives node size/color in the Overview. */
  heat: number;
}

export interface TableLoad {
  queryCount: number;
  execCount: number;
  totalTimeMs: number;
  avgTimeMs: number;
  rowsExamined: number;
  fullScanCount: number;
}

// ------------------------------------------------------------------- issues

export type IssueCode =
  | "FULL_SCAN"
  | "N_PLUS_ONE"
  | "LARGE_OFFSET"
  | "LEADING_WILDCARD"
  | "NON_SARGABLE"
  | "CORRELATED_SUBQUERY"
  | "NO_INDEX"
  | "NO_PRIMARY_KEY"
  | "FILESORT"
  | "TEMPORARY"
  | "HUGE_ROWS"
  | "UNINDEXED_FK"
  | "LOW_INDEX_COVERAGE"
  | "SELECT_STAR"
  | "BAD_TYPE";

export type Severity = "critical" | "warning" | "info";

export interface Issue {
  code: IssueCode;
  severity: Severity;
  /** One line, in the user's language, stating what is wrong. */
  title: string;
  /** Why it matters / what to do. Kept concise for incident response and tuning. */
  detail: string;
  /** Where it applies, when relevant. */
  table?: string | undefined;
  columns?: string[];
  /** Ready-to-run DDL, when the fix is mechanical. */
  suggestion?: string;
  /** The same change as CREATE/DROP INDEX, for the project's own SQL files. */
  fileSuggestion?: string;
}

// ----------------------------------------------------------------- overview

export interface OverviewPayload {
  database: string;
  generatedAt: string;
  tables: TableSummary[];
  relations: RelationInfo[];
  totals: {
    tableCount: number;
    rowCount: number;
    dataBytes: number;
    indexBytes: number;
  };
  issues: Issue[];
  perfSchema: PerfSchemaStatus;
}

// -------------------------------------------------------------- table detail

export interface TableDetailPayload {
  name: string;
  summary: TableSummary;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  createStatement: string;
  relations: RelationInfo[];
  queries: QueryStat[];
  issues: Issue[];
}

export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "is_null"
  | "is_not_null";

/** A single safe Data Viewer filter. Column and operator are allowlisted server-side. */
export interface DataFilter {
  column: string;
  operator: FilterOperator;
  value?: string | undefined;
}

export interface DataPage {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  /** InnoDB estimate; exact counts on huge tables are themselves a bottleneck. */
  estimatedTotal: number;
  orderBy: string | null;
  orderDir: "asc" | "desc";
  elapsedMs: number;
}

// -------------------------------------------------------------------- query

export type AdviceKind = "batch" | "rewrite" | "index" | "cache" | "measure";
export type AdviceConfidence = "high" | "medium" | "low";

export interface QueryAdvice {
  kind: AdviceKind;
  confidence: AdviceConfidence;
  priority: number;
  title: string;
  detail: string;
  example?: string | undefined;
}

export interface QueryStat {
  digest: string;
  /** performance_schema's normalized form, with literals as `?`. */
  sample: string;
  digestText: string;
  execCount: number;
  totalTimeMs: number;
  avgTimeMs: number;
  maxTimeMs: number;
  rowsSent: number;
  rowsExamined: number;
  /** rowsExamined / rowsSent. High means the server is reading to throw away. */
  examinedPerSent: number;
  noIndexUsed: number;
  noGoodIndexUsed: number;
  createdTmpTables: number;
  createdTmpDiskTables: number;
  sortMergePasses: number;
  tables: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** 0..100, share of total observed execution time. */
  impact: number;
  issues: Issue[];
  /** Prioritized query-level improvements; rewrites/batching may outrank indexes. */
  advice: QueryAdvice[];
}

// ------------------------------------------------------------------ explain

export interface ExplainRow {
  id: number;
  selectType: string;
  table: string | null;
  partitions: string | null;
  type: string | null;
  possibleKeys: string | null;
  key: string | null;
  keyLen: string | null;
  ref: string | null;
  rows: number | null;
  filtered: number | null;
  extra: string | null;
}

/** One box in the visual pipeline. */
export interface PlanStep {
  id: string;
  kind:
    | "table"
    | "full_scan"
    | "index_scan"
    | "range"
    | "ref"
    | "eq_ref"
    | "const"
    | "join"
    | "filesort"
    | "temporary"
    | "limit"
    | "group"
    | "distinct"
    | "subquery"
    | "result";
  label: string;
  sublabel?: string | undefined;
  table?: string | undefined;
  rows?: number | undefined;
  severity: Severity | "none";
  notes: string[];
}

export interface ExplainPayload {
  sql: string;
  rows: ExplainRow[];
  steps: PlanStep[];
  issues: Issue[];
  /** Product of per-step row estimates: the cost the planner is signing up for. */
  estimatedCost: number;
  json: unknown | null;
  analyze: string | null;
  elapsedMs: number;
  /** Query rewrites and behavioral improvements, prioritized before schema changes. */
  advice: QueryAdvice[];
  /** Index hints derived from the plan + the actual schema. */
  suggestions: IndexSuggestion[];
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  ddl: string;
  fileDdl: string;
  confidence: AdviceConfidence;
  /** Risks or checks that should happen before keeping this index. */
  tradeoffs: string[];
  /** True when an existing index already covers this prefix. */
  redundant: boolean;
}

// -------------------------------------------------------------------- index

export interface CreateIndexRequest {
  table: string;
  name?: string | undefined;
  columns: string[];
  unique?: boolean;
}

export interface IndexMutationResult {
  ok: boolean;
  /** The statement DBSCOPE ran. */
  ddl: string;
  /**
   * The same change as plain CREATE/DROP INDEX, for the project's own schema
   * or migration files: no ALTER TABLE, no CONCURRENTLY, no schema qualifier.
   */
  fileDdl: string;
  elapsedMs: number;
  message: string;
}

/** The improvement loop's payload: same SQL, two plans, one verdict. */
export interface BeforeAfter {
  before: ExplainPayload;
  after: ExplainPayload;
  ddl: string;
  fileDdl: string;
  verdict: {
    rowsBefore: number;
    rowsAfter: number;
    /** Positive = fewer rows examined. */
    improvementPct: number;
    resolved: IssueCode[];
    introduced: IssueCode[];
    summary: string;
  };
}

export interface ApiError {
  error: string;
  detail?: string | undefined;
  /** MySQL's own error code, when the failure came from the server. */
  code?: string;
}
