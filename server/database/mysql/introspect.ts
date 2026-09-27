import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ColumnInfo, IndexInfo, RelationInfo } from "#shared/types.ts";
import type { RawTable } from "../../core/load.ts";

/**
 * information_schema.TABLES gives InnoDB *estimates* for TABLE_ROWS. They can be
 * off by a wide margin, but they are free, and on a live database an exact
 * COUNT(*) over a large table can itself cause avoidable load. The UI labels
 * these as approximate.
 */
export async function fetchTables(pool: Pool, schema: string): Promise<RawTable[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, TABLE_COMMENT
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`,
    [schema],
  );
  return rows.map((r) => ({
    name: String(r.TABLE_NAME),
    engine: String(r.ENGINE ?? "unknown"),
    rows: Number(r.TABLE_ROWS ?? 0),
    dataBytes: Number(r.DATA_LENGTH ?? 0),
    indexBytes: Number(r.INDEX_LENGTH ?? 0),
    comment: String(r.TABLE_COMMENT ?? ""),
  }));
}

export async function fetchColumns(pool: Pool, schema: string): Promise<Map<string, ColumnInfo[]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
            COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );

  const map = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const table = String(r.TABLE_NAME);
    const list = map.get(table) ?? [];
    list.push({
      name: String(r.COLUMN_NAME),
      dataType: String(r.DATA_TYPE),
      columnType: String(r.COLUMN_TYPE),
      nullable: r.IS_NULLABLE === "YES",
      key: String(r.COLUMN_KEY ?? ""),
      defaultValue: r.COLUMN_DEFAULT === null ? null : String(r.COLUMN_DEFAULT),
      extra: String(r.EXTRA ?? ""),
      comment: String(r.COLUMN_COMMENT ?? ""),
    });
    map.set(table, list);
  }
  return map;
}

export async function fetchIndexes(pool: Pool, schema: string): Promise<Map<string, IndexInfo[]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
            CARDINALITY, INDEX_TYPE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );

  // Rows arrive one per column; fold them into one entry per index.
  const byTable = new Map<string, Map<string, IndexInfo>>();
  for (const r of rows) {
    const table = String(r.TABLE_NAME);
    const indexName = String(r.INDEX_NAME);
    const perTable = byTable.get(table) ?? new Map<string, IndexInfo>();
    const existing = perTable.get(indexName);

    if (existing) {
      existing.columns.push(String(r.COLUMN_NAME));
    } else {
      perTable.set(indexName, {
        name: indexName,
        unique: Number(r.NON_UNIQUE) === 0,
        type: String(r.INDEX_TYPE ?? "BTREE"),
        columns: [String(r.COLUMN_NAME)],
        // Cardinality of the leftmost column is the useful figure.
        cardinality: r.CARDINALITY === null ? null : Number(r.CARDINALITY),
        isPrimary: indexName === "PRIMARY",
      });
    }
    byTable.set(table, perTable);
  }

  const out = new Map<string, IndexInfo[]>();
  for (const [table, perTable] of byTable) {
    // PRIMARY first, then the rest alphabetically: matches how people read DDL.
    const list = [...perTable.values()].sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    out.set(table, list);
  }
  return out;
}

async function fetchForeignKeys(pool: Pool, schema: string): Promise<RelationInfo[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [schema],
  );
  return rows.map((r) => ({
    fromTable: String(r.TABLE_NAME),
    fromColumn: String(r.COLUMN_NAME),
    toTable: String(r.REFERENCED_TABLE_NAME),
    toColumn: String(r.REFERENCED_COLUMN_NAME),
    kind: "foreign_key" as const,
    confidence: 1,
    unindexed: false,
  }));
}

/** Rough, deliberate singularization: users -> user, categories -> category. */
function singular(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("ches")) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

/**
 * Many application schemas do not declare foreign keys, yet the relations are
 * obviously there. Infer them from the `<table>_id` convention so the ER graph
 * is useful anyway, and mark each guess with a confidence the UI can show.
 */
function inferRelations(
  tables: RawTable[],
  columns: Map<string, ColumnInfo[]>,
  declared: RelationInfo[],
): RelationInfo[] {
  const names = tables.map((t) => t.name);
  const declaredKeys = new Set(declared.map((r) => `${r.fromTable}.${r.fromColumn}`));

  // Index target tables by their likely reference stem.
  const stems = new Map<string, string>();
  for (const name of names) {
    stems.set(singular(name).toLowerCase(), name);
    stems.set(name.toLowerCase(), name);
  }

  const out: RelationInfo[] = [];
  for (const table of names) {
    for (const column of columns.get(table) ?? []) {
      const lower = column.name.toLowerCase();
      if (!lower.endsWith("_id") || lower === "id") continue;
      if (declaredKeys.has(`${table}.${column.name}`)) continue;

      const stem = lower.slice(0, -3);
      const target = stems.get(stem);
      if (!target || target === table) continue;

      // The referenced side is nearly always the PK. Confirm it exists.
      const targetPk = (columns.get(target) ?? []).find((c) => c.key === "PRI");
      if (!targetPk) continue;

      out.push({
        fromTable: table,
        fromColumn: column.name,
        toTable: target,
        toColumn: targetPk.name,
        kind: "inferred",
        // An exact singular match is a strong signal; a plural one slightly less.
        confidence: stem === singular(target).toLowerCase() ? 0.9 : 0.7,
        unindexed: false,
      });
    }
  }
  return out;
}

/**
 * A relation whose FK side has no index as its leftmost column means every join
 * across it scans. That is the single most valuable thing to show on an ER
 * diagram during investigation, so it is computed here rather than in the UI.
 */
function markUnindexed(
  relations: RelationInfo[],
  indexes: Map<string, IndexInfo[]>,
): RelationInfo[] {
  return relations.map((rel) => {
    const list = indexes.get(rel.fromTable) ?? [];
    const covered = list.some((idx) => idx.columns[0] === rel.fromColumn);
    return { ...rel, unindexed: !covered };
  });
}

export async function fetchRelations(
  pool: Pool,
  schema: string,
  tables: RawTable[],
  columns: Map<string, ColumnInfo[]>,
  indexes: Map<string, IndexInfo[]>,
): Promise<RelationInfo[]> {
  const declared = await fetchForeignKeys(pool, schema);
  const inferred = inferRelations(tables, columns, declared);
  return markUnindexed([...declared, ...inferred], indexes);
}

export async function fetchCreateStatement(pool: Pool, table: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quoteIdent(table)}`);
  return String(rows[0]?.["Create Table"] ?? "");
}

/**
 * Identifiers cannot be parameterized, so every identifier that reaches SQL
 * goes through here. Backticks are escaped by doubling; anything containing a
 * backtick or NUL is rejected outright.
 */
export function quoteIdent(name: string): string {
  if (!/^[\w$\u0080-\uFFFF ]+$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

/** Confirm a table exists in this schema before interpolating its name. */
export async function assertTableExists(pool: Pool, schema: string, table: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [schema, table],
  );
  if (rows.length === 0) throw new Error(`unknown table: ${table}`);
}
