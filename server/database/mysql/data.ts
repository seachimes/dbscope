import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  CreateIndexRequest,
  DataFilter,
  DataPage,
  IndexInfo,
  IndexMutationResult,
} from "#shared/types.ts";
import { CELL_PREVIEW_CHARS } from "../adapter.ts";
import { assertTableExists, quoteIdent } from "./introspect.ts";

const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 10_000;

const TEXT_TYPES = new Set([
  "char",
  "varchar",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "json",
]);
const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Select a preview of each column; see CELL_PREVIEW_CHARS. */
export function previewColumn(name: string, dataType: string): string {
  const ident = quoteIdent(name);
  const type = dataType.toLowerCase();
  if (TEXT_TYPES.has(type)) return `LEFT(${ident}, ${CELL_PREVIEW_CHARS}) AS ${ident}`;
  if (BINARY_TYPES.has(type)) {
    return `CONCAT('<binary ', OCTET_LENGTH(${ident}), ' B>') AS ${ident}`;
  }
  return ident;
}

/**
 * Page through a table's rows.
 *
 * Identifiers cannot be bound as parameters, so table/column names are checked
 * against information_schema and then quoted. Values always travel as bound
 * parameters.
 */
export async function fetchPage(
  pool: Pool,
  schema: string,
  table: string,
  opts: {
    page?: number;
    pageSize?: number;
    orderBy?: string | null;
    orderDir?: "asc" | "desc";
    filter?: DataFilter | null;
  } = {},
): Promise<DataPage> {
  await assertTableExists(pool, schema, table);

  const requestedSize = Number.isSafeInteger(opts.pageSize) ? opts.pageSize! : 50;
  const requestedPage = Number.isSafeInteger(opts.page) ? opts.page! : 1;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 1), MAX_PAGE);
  const offset = (page - 1) * pageSize;
  const orderDir = opts.orderDir === "desc" ? "DESC" : "ASC";

  const [cols] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table],
  );
  const columnNames = cols.map((c) => String(c.COLUMN_NAME));
  const projection = cols
    .map((c) => previewColumn(String(c.COLUMN_NAME), String(c.DATA_TYPE)))
    .join(", ");

  // Sorting by an arbitrary user-supplied column is only safe once we know the
  // column actually exists on this table. The table qualifier matters: a bare
  // name would resolve to the truncated preview alias, not the column.
  let orderClause = "";
  let orderBy: string | null = null;
  if (opts.orderBy && columnNames.includes(opts.orderBy)) {
    orderBy = opts.orderBy;
    orderClause = ` ORDER BY ${quoteIdent(table)}.${quoteIdent(orderBy)} ${orderDir}`;
  }

  // Filters are structured: the column is validated against information_schema,
  // the operator comes from a fixed map, and the value is always bound. This
  // makes the Data Viewer incapable of smuggling subqueries or expensive SQL.
  let whereClause = "";
  const values: unknown[] = [];
  if (opts.filter) {
    const { column, operator } = opts.filter;
    if (!columnNames.includes(column)) throw new Error(`unknown filter column: ${column}`);
    const ident = quoteIdent(column);
    const scalarOps: Record<string, string> = {
      eq: "=",
      ne: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    if (operator in scalarOps) {
      whereClause = ` WHERE ${ident} ${scalarOps[operator]} ?`;
      values.push(opts.filter.value ?? "");
    } else if (operator === "contains" || operator === "starts_with") {
      whereClause = ` WHERE ${ident} LIKE ? ESCAPE '\\\\'`;
      const escaped = escapeLike(opts.filter.value ?? "");
      values.push(operator === "contains" ? `%${escaped}%` : `${escaped}%`);
    } else if (operator === "is_null") {
      whereClause = ` WHERE ${ident} IS NULL`;
    } else if (operator === "is_not_null") {
      whereClause = ` WHERE ${ident} IS NOT NULL`;
    } else {
      throw new Error(`unsupported filter operator: ${operator}`);
    }
  }

  const started = performance.now();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${projection} FROM ${quoteIdent(table)}${whereClause}${orderClause} LIMIT ? OFFSET ?`,
    [...values, pageSize, offset],
  );
  const elapsedMs = Math.round(performance.now() - started);

  // Deliberately the InnoDB estimate: an exact COUNT(*) of a large table is
  // itself the kind of stall this tool exists to prevent.
  const [meta] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_ROWS FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table],
  );

  return {
    columns: columnNames,
    rows: rows.map((r) => ({ ...r })),
    page,
    pageSize,
    estimatedTotal: Number(meta[0]?.TABLE_ROWS ?? 0),
    orderBy,
    orderDir: orderDir === "DESC" ? "desc" : "asc",
    elapsedMs,
  };
}

export async function createIndex(
  pool: Pool,
  schema: string,
  req: CreateIndexRequest,
): Promise<IndexMutationResult> {
  await assertTableExists(pool, schema, req.table);
  if (!req.columns.length) throw new Error("at least one column is required");

  const [existing] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, req.table],
  );
  const valid = new Set(existing.map((c) => String(c.COLUMN_NAME)));
  for (const col of req.columns) {
    if (!valid.has(col)) throw new Error(`unknown column: ${req.table}.${col}`);
  }

  const name = req.name?.trim() || `idx_${req.columns.join("_")}`.slice(0, 60);
  const ddl =
    `ALTER TABLE ${quoteIdent(req.table)} ADD ${req.unique ? "UNIQUE " : ""}INDEX ` +
    `${quoteIdent(name)} (${req.columns.map(quoteIdent).join(", ")})`;

  const started = performance.now();
  await pool.query<ResultSetHeader>(ddl);
  const elapsedMs = Math.round(performance.now() - started);

  return {
    ok: true,
    ddl: ddl + ";",
    elapsedMs,
    message: `Created ${name} on ${req.table} (${req.columns.join(", ")}) in ${elapsedMs} ms`,
  };
}

export async function dropIndex(
  pool: Pool,
  schema: string,
  table: string,
  indexName: string,
): Promise<IndexMutationResult> {
  await assertTableExists(pool, schema, table);
  if (indexName.toUpperCase() === "PRIMARY") {
    throw new Error("refusing to drop the PRIMARY KEY");
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.NON_UNIQUE, c.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME
       FROM information_schema.STATISTICS s
       LEFT JOIN information_schema.TABLE_CONSTRAINTS c
         ON  c.TABLE_SCHEMA = s.TABLE_SCHEMA
         AND c.TABLE_NAME   = s.TABLE_NAME
         AND c.CONSTRAINT_NAME = s.INDEX_NAME
       LEFT JOIN information_schema.KEY_COLUMN_USAGE k
         ON  k.TABLE_SCHEMA = s.TABLE_SCHEMA
         AND k.TABLE_NAME   = s.TABLE_NAME
         AND k.CONSTRAINT_NAME = s.INDEX_NAME
         AND k.REFERENCED_TABLE_NAME IS NOT NULL
      WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME = ? AND s.INDEX_NAME = ?
      LIMIT 1`,
    [schema, table, indexName],
  );
  const index = rows[0];
  if (!index) throw new Error(`unknown index: ${indexName}`);

  // A UNIQUE index is a data guarantee, not a performance choice. MySQL will
  // drop it without complaint and duplicates become insertable immediately —
  // a silent correctness change made while looking at a performance screen.
  if (Number(index.NON_UNIQUE) === 0) {
    throw new Error(
      `${indexName} enforces a UNIQUE constraint on ${table}. Dropping it would allow duplicate rows, so it cannot be removed here; use ALTER TABLE directly if that is genuinely intended.`,
    );
  }

  // An index backing a foreign key cannot be dropped while the FK needs it, and
  // saying so is more useful than surfacing MySQL's errno 1553.
  if (index.REFERENCED_TABLE_NAME) {
    throw new Error(
      `${indexName} supports a foreign key on ${table}; drop the constraint first if that is genuinely intended.`,
    );
  }

  const ddl = `ALTER TABLE ${quoteIdent(table)} DROP INDEX ${quoteIdent(indexName)}`;
  const started = performance.now();
  await pool.query<ResultSetHeader>(ddl);
  const elapsedMs = Math.round(performance.now() - started);

  return {
    ok: true,
    ddl: ddl + ";",
    elapsedMs,
    message: `Dropped ${indexName} from ${table} in ${elapsedMs} ms`,
  };
}

export async function listIndexes(pool: Pool, schema: string, table: string): Promise<IndexInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY, INDEX_TYPE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [schema, table],
  );

  const byName = new Map<string, IndexInfo>();
  for (const r of rows) {
    const name = String(r.INDEX_NAME);
    const existing = byName.get(name);
    if (existing) {
      existing.columns.push(String(r.COLUMN_NAME));
      continue;
    }
    byName.set(name, {
      name,
      unique: Number(r.NON_UNIQUE) === 0,
      type: String(r.INDEX_TYPE ?? "BTREE"),
      columns: [String(r.COLUMN_NAME)],
      cardinality: r.CARDINALITY === null ? null : Number(r.CARDINALITY),
      isPrimary: name === "PRIMARY",
    });
  }

  return [...byName.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
