import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CreateIndexRequest, DataPage, IndexMutationResult } from "#shared/types.ts";
import { CELL_PREVIEW_CHARS, type PageOptions } from "../adapter.ts";
import type { IndexDdl, Statements } from "../../core/rules.ts";
import { qualify, quoteIdent, toNumber } from "./sql.ts";

const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 10_000;

const SCALAR_OPERATORS: Record<string, string> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** Actual columns and their cast targets, straight from the catalog. */
async function columnMetadata(
  pool: Pool,
  schema: string,
  table: string,
): Promise<Array<{ name: string; typeSchema: string; typeName: string; category: string }>> {
  const { rows } = await pool.query(
    `SELECT a.attname::text AS name, tn.nspname::text AS type_schema,
            t.typname::text AS type_name, t.typcategory::text AS category
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
      WHERE n.nspname = $1 AND c.relname = $2
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  if (rows.length === 0) throw new Error(`unknown table: ${table}`);
  return rows.map((r) => ({
    name: String(r.name),
    typeSchema: String(r.type_schema),
    typeName: String(r.type_name),
    category: String(r.category),
  }));
}

async function columnNames(pool: Pool, schema: string, table: string): Promise<string[]> {
  return (await columnMetadata(pool, schema, table)).map((column) => column.name);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Select a preview of each column; see CELL_PREVIEW_CHARS. */
export function previewColumn(column: {
  name: string;
  typeSchema: string;
  typeName: string;
  category: string;
}): string {
  const ident = quoteIdent(column.name);
  const builtin = column.typeSchema === "pg_catalog";
  if (builtin && column.typeName === "bytea") {
    return `'<binary ' || octet_length(${ident}) || ' B>' AS ${ident}`;
  }
  if (builtin && ["json", "jsonb", "xml"].includes(column.typeName)) {
    return `left(${ident}::text, ${CELL_PREVIEW_CHARS}) AS ${ident}`;
  }
  if (column.category === "S") return `left(${ident}, ${CELL_PREVIEW_CHARS}) AS ${ident}`;
  return ident;
}

/**
 * Page through a table.
 *
 * Identifiers are validated against the catalog and then quoted; values always
 * travel as bound parameters, so the Data Viewer cannot smuggle SQL. The read
 * runs in a read-only transaction with a statement timeout so a wide filter on
 * a large table cannot hold resources.
 */
export async function fetchPage(
  pool: Pool,
  schema: string,
  table: string,
  opts: PageOptions = {},
): Promise<DataPage> {
  const metadata = await columnMetadata(pool, schema, table);
  const columns = metadata.map((column) => column.name);

  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), MAX_PAGE_SIZE);
  const page = Math.min(Math.max(opts.page ?? 1, 1), MAX_PAGE);
  const orderDir = opts.orderDir === "desc" ? "DESC" : "ASC";

  const values: unknown[] = [];
  let where = "";
  if (opts.filter) {
    const { column, operator, value } = opts.filter;
    if (!columns.includes(column)) throw new Error(`unknown filter column: ${column}`);
    const ident = quoteIdent(column);

    const type = metadata.find((entry) => entry.name === column)!;
    if (Object.hasOwn(SCALAR_OPERATORS, operator)) {
      const ordered = operator !== "eq" && operator !== "ne";
      // Only types with predictable native comparison semantics are supported.
      // Casting the *parameter*, never the indexed column, preserves numeric and
      // temporal ordering as well as the possibility of an index scan.
      const comparable = ["N", "S", "D", "E"].includes(type.category);
      const equalityOnly =
        type.category === "B" || (type.typeSchema === "pg_catalog" && type.typeName === "uuid");
      if (!comparable && !(equalityOnly && !ordered)) {
        throw new Error(
          `filter operator ${operator} is not supported for ${column} (${type.typeName}); ` +
            `use is_null/is_not_null${type.category === "B" ? " or eq/ne" : ""}`,
        );
      }
      values.push(value ?? "");
      const cast = `${quoteIdent(type.typeSchema)}.${quoteIdent(type.typeName)}`;
      where = ` WHERE ${ident} ${SCALAR_OPERATORS[operator]} $${values.length}::${cast}`;
    } else if (operator === "contains" || operator === "starts_with") {
      if (type.category !== "S" && type.category !== "E") {
        throw new Error(
          `filter operator ${operator} requires a text column; ${column} is ${type.typeName}. ` +
            "Use eq/ne or a native range comparison instead",
        );
      }
      const escaped = escapeLike(value ?? "");
      values.push(operator === "contains" ? `%${escaped}%` : `${escaped}%`);
      // Enum labels need text conversion; ordinary text types need no column
      // cast, allowing a normal text index to serve starts_with where possible.
      where = ` WHERE ${ident}${type.category === "E" ? "::text" : ""} LIKE $${values.length} ESCAPE '\\'`;
    } else if (operator === "is_null" || operator === "is_not_null") {
      where = ` WHERE ${ident} IS ${operator === "is_null" ? "" : "NOT "}NULL`;
    } else {
      throw new Error(`unsupported filter operator: ${operator}`);
    }
  }

  const orderBy = opts.orderBy && columns.includes(opts.orderBy) ? opts.orderBy : null;
  // Qualified, because a bare name would resolve to the truncated preview alias.
  const order = orderBy
    ? ` ORDER BY ${qualify(schema, table)}.${quoteIdent(orderBy)} ${orderDir}`
    : "";

  values.push(pageSize, (page - 1) * pageSize);
  const limitParam = `$${values.length - 1}`;
  const offsetParam = `$${values.length}`;

  const client = await pool.connect();
  const started = performance.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await client.query(
      `SELECT ${metadata.map(previewColumn).join(", ")} FROM ${qualify(schema, table)}${where}${order} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    const estimate = await client.query(
      `SELECT GREATEST(c.reltuples, 0)::bigint AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );

    return {
      columns,
      rows: result.rows,
      page,
      pageSize,
      estimatedTotal: toNumber(estimate.rows[0]?.n),
      orderBy,
      orderDir: orderDir === "DESC" ? "desc" : "asc",
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/**
 * PostgreSQL index names are schema-wide and limited to 63 bytes.
 *
 * When a name has to be truncated, the suffix hashes the *whole* candidate.
 * Hashing only the surviving prefix would defeat the purpose: that prefix is
 * exactly what two colliding names have in common.
 */
export function indexName(request: CreateIndexRequest): string {
  const candidate = request.name?.trim() || `idx_${request.table}_${request.columns.join("_")}`;
  if (Buffer.byteLength(candidate) <= 63) return candidate;

  const suffix = `_${createHash("sha1").update(candidate).digest("hex").slice(0, 6)}`;
  // Decoding a byte slice can split a multi-byte character; drop the resulting
  // replacement character so the name stays valid UTF-8.
  const head = Buffer.from(candidate)
    .subarray(0, 63 - suffix.length)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return head + suffix;
}

/**
 * CONCURRENTLY keeps a live workload running here, but it cannot run inside a
 * transaction, which is how most migration tools apply a file. The file form
 * therefore drops it, along with the schema qualifier the file's own
 * search_path supplies.
 */
export function createIndexDdl(schema: string, request: CreateIndexRequest): Statements {
  const unique = request.unique ? "UNIQUE " : "";
  const name = quoteIdent(indexName(request));
  const columns = request.columns.map(quoteIdent).join(", ");
  return {
    ddl: `CREATE ${unique}INDEX CONCURRENTLY ${name} ON ${qualify(schema, request.table)} (${columns});`,
    fileDdl: `CREATE ${unique}INDEX ${name} ON ${quoteIdent(request.table)} (${columns});`,
  };
}

export function dropIndexDdl(schema: string, name: string): Statements {
  return {
    ddl: `DROP INDEX CONCURRENTLY ${qualify(schema, name)};`,
    fileDdl: `DROP INDEX ${quoteIdent(name)};`,
  };
}

export function indexDdlFor(schema: string): IndexDdl {
  return {
    create: (table, columns) => createIndexDdl(schema, { table, columns }),
    drop: (_table, index) => dropIndexDdl(schema, index),
  };
}

/**
 * Create an index with CONCURRENTLY so an existing workload keeps running.
 *
 * CONCURRENTLY cannot run inside a transaction and takes longer, but a blocking
 * CREATE INDEX on a live table is the more damaging default. A failed build can
 * leave an INVALID index behind, which is reported rather than hidden.
 */
export async function createIndex(
  pool: Pool,
  schema: string,
  request: CreateIndexRequest,
): Promise<IndexMutationResult> {
  const columns = await columnNames(pool, schema, request.table);
  for (const column of request.columns) {
    if (!columns.includes(column)) throw new Error(`unknown column: ${column}`);
  }

  const name = indexName(request);
  const statements = createIndexDdl(schema, request);

  const started = performance.now();
  try {
    await pool.query(statements.ddl.slice(0, -1));
  } catch (err) {
    throw new Error(
      `${(err as Error).message}. A cancelled CREATE INDEX CONCURRENTLY can leave an INVALID index named ${name}; drop it before retrying.`,
    );
  }

  return {
    ok: true,
    ...statements,
    elapsedMs: Math.round(performance.now() - started),
    message: `Created ${name} on ${request.table}`,
  };
}

/**
 * Drop a non-unique index, refusing indexes that enforce data guarantees.
 *
 * A PRIMARY KEY or UNIQUE constraint owns its index, but a standalone UNIQUE
 * index also enforces uniqueness without an entry in pg_constraint. Dropping
 * either kind would change data guarantees rather than just performance.
 */
export async function dropIndex(
  pool: Pool,
  schema: string,
  table: string,
  name: string,
): Promise<IndexMutationResult> {
  const { rows } = await pool.query(
    `SELECT i.indisprimary AS is_primary, i.indisunique AS is_unique,
            con.conname AS constraint_name
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_constraint con ON con.conindid = idx.oid
      WHERE n.nspname = $1 AND t.relname = $2 AND idx.relname = $3`,
    [schema, table, name],
  );

  const index = rows[0];
  if (!index) throw new Error(`unknown index: ${name}`);
  if (index.is_primary) throw new Error("refusing to drop the PRIMARY KEY");
  if (index.constraint_name) {
    throw new Error(
      `${name} backs constraint ${index.constraint_name}; drop the constraint with ALTER TABLE if that is really intended`,
    );
  }
  if (index.is_unique) {
    throw new Error(`${name} enforces uniqueness; refusing to drop a UNIQUE index`);
  }

  const statements = dropIndexDdl(schema, name);
  const started = performance.now();
  await pool.query(statements.ddl.slice(0, -1));

  return {
    ok: true,
    ...statements,
    elapsedMs: Math.round(performance.now() - started),
    message: `Dropped ${name}`,
  };
}
