import type { Pool } from "pg";
import type { ColumnInfo, IndexInfo, RelationInfo } from "#shared/types.ts";
import type { RawTable } from "../../core/load.ts";
import { toNumber, toStringArray } from "./sql.ts";

/**
 * `reltuples` is the planner's estimate, refreshed by ANALYZE/VACUUM, and is
 * -1 on a relation that has never been analyzed. It is clamped to 0 here and
 * labeled approximate in the UI, because an exact COUNT(*) on a large table is
 * itself the kind of load this tool exists to avoid.
 */
export async function fetchTables(pool: Pool, schema: string): Promise<RawTable[]> {
  const { rows } = await pool.query(
    `SELECT c.relname AS name,
            GREATEST(c.reltuples, 0)::bigint AS rows,
            pg_table_size(c.oid)::bigint AS data_bytes,
            pg_indexes_size(c.oid)::bigint AS index_bytes,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY pg_total_relation_size(c.oid) DESC`,
    [schema],
  );
  return rows.map((r) => ({
    name: String(r.name),
    engine: "PostgreSQL",
    rows: toNumber(r.rows),
    dataBytes: toNumber(r.data_bytes),
    indexBytes: toNumber(r.index_bytes),
    comment: String(r.comment ?? ""),
  }));
}

export async function fetchColumns(pool: Pool, schema: string): Promise<Map<string, ColumnInfo[]>> {
  const { rows } = await pool.query(
    `SELECT c.relname AS table_name,
            a.attname::text AS column_name,
            format_type(a.atttypid, a.atttypmod) AS column_type,
            t.typname::text AS data_type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
            EXISTS (
              SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
            ) AS is_primary,
            CASE WHEN a.attidentity <> '' THEN 'identity'
                 WHEN a.attgenerated <> '' THEN 'generated'
                 ELSE '' END AS extra,
            COALESCE(col_description(c.oid, a.attnum), '') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );

  // Map.groupBy preserves input order within each group, so the ORDER BY above
  // still decides column order. Grouping and shaping stay separate concerns.
  return new Map(
    Map.groupBy(rows, (r) => String(r.table_name))
      .entries()
      .map(([table, columns]) => [
        table,
        columns.map((r) => ({
          name: String(r.column_name),
          dataType: String(r.data_type),
          columnType: String(r.column_type),
          nullable: Boolean(r.nullable),
          key: r.is_primary ? "PRI" : "",
          defaultValue: r.column_default === null ? null : String(r.column_default),
          extra: String(r.extra ?? ""),
          comment: String(r.comment ?? ""),
        })),
      ]),
  );
}

/**
 * One row per index, with key columns already ordered.
 *
 * Two details matter here:
 *
 * 1. `attname` is of type `name`, so `array_agg` yields `name[]` (OID 1003).
 *    node-postgres has no parser for that OID and would return the raw literal
 *    `{id,user_id}` as a string. The cast to `text[]` keeps it a real array.
 * 2. Only `indnkeyatts` entries are key columns; trailing INCLUDE columns are
 *    not part of the search key and must not be presented as if they were.
 *
 * Cardinality is deliberately left null: `pg_class.reltuples` on an index is an
 * entry count, not a distinct-value count, and reporting it as cardinality
 * would be a plausible-looking lie.
 */
export async function fetchIndexes(pool: Pool, schema: string): Promise<Map<string, IndexInfo[]>> {
  const { rows } = await pool.query(
    `SELECT t.relname AS table_name,
            idx.relname AS index_name,
            i.indisunique AS is_unique,
            i.indisprimary AS is_primary,
            i.indisvalid AS is_valid,
            am.amname::text AS access_method,
            (SELECT array_agg(pg_get_indexdef(i.indexrelid, k.pos, true)::text ORDER BY k.pos)
               FROM generate_series(1, i.indnkeyatts) AS k(pos)) AS columns
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_am am ON am.oid = idx.relam
      WHERE n.nspname = $1
        AND t.relkind IN ('r', 'p')
      ORDER BY t.relname, i.indisprimary DESC, idx.relname`,
    [schema],
  );

  const byTable = new Map<string, IndexInfo[]>();
  for (const r of rows) {
    const table = String(r.table_name);
    const list = byTable.get(table) ?? [];
    list.push({
      name: String(r.index_name),
      unique: Boolean(r.is_unique),
      type: String(r.access_method ?? "btree").toUpperCase(),
      columns: toStringArray(r.columns),
      cardinality: null,
      isPrimary: Boolean(r.is_primary),
      valid: Boolean(r.is_valid),
    });
    byTable.set(table, list);
  }
  return byTable;
}

/** True when an index can serve lookups whose leading key is `column`. */
function hasLeadingColumn(indexes: IndexInfo[], column: string): boolean {
  return indexes.some((i) => i.columns[0] === column);
}

export async function fetchRelations(
  pool: Pool,
  schema: string,
  tables: RawTable[],
  columns: Map<string, ColumnInfo[]>,
  indexes: Map<string, IndexInfo[]>,
): Promise<RelationInfo[]> {
  // unnest WITH ORDINALITY pairs composite key columns positionally; joining on
  // the constraint alone would produce a cross product for multi-column FKs.
  const { rows } = await pool.query(
    `SELECT src.relname AS from_table,
            sa.attname::text AS from_column,
            dst.relname AS to_table,
            da.attname::text AS to_column
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace sn ON sn.oid = src.relnamespace
       JOIN pg_class dst ON dst.oid = con.confrelid
       JOIN pg_namespace dn ON dn.oid = dst.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS fk(attnum, ord)
       JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS pk(attnum, ord)
         ON pk.ord = fk.ord
       JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = fk.attnum
       JOIN pg_attribute da ON da.attrelid = dst.oid AND da.attnum = pk.attnum
      WHERE con.contype = 'f'
        AND sn.nspname = $1
        AND dn.nspname = $1
      ORDER BY src.relname, con.conname, fk.ord`,
    [schema],
  );

  const relations: RelationInfo[] = rows.map((r) => ({
    fromTable: String(r.from_table),
    fromColumn: String(r.from_column),
    toTable: String(r.to_table),
    toColumn: String(r.to_column),
    kind: "foreign_key",
    confidence: 1,
    unindexed: !hasLeadingColumn(indexes.get(String(r.from_table)) ?? [], String(r.from_column)),
  }));

  // Many schemas never declare foreign keys, yet the relations are obvious from
  // naming. Inferred edges are marked as such so the UI can distinguish them.
  const stems = new Map<string, string>();
  for (const t of tables) {
    stems.set(t.name, t.name);
    stems.set(t.name.replace(/ies$/, "y").replace(/s$/, ""), t.name);
  }

  for (const table of tables) {
    for (const column of columns.get(table.name) ?? []) {
      if (!column.name.endsWith("_id")) continue;
      if (relations.some((r) => r.fromTable === table.name && r.fromColumn === column.name))
        continue;

      const target = stems.get(column.name.slice(0, -3));
      if (!target || target === table.name) continue;
      const targetPk = (columns.get(target) ?? []).find((c) => c.key === "PRI");
      if (!targetPk) continue;

      relations.push({
        fromTable: table.name,
        fromColumn: column.name,
        toTable: target,
        toColumn: targetPk.name,
        kind: "inferred",
        confidence: 0.8,
        unindexed: !hasLeadingColumn(indexes.get(table.name) ?? [], column.name),
      });
    }
  }

  return relations;
}

/**
 * PostgreSQL has no SHOW CREATE TABLE. This reconstructs a readable definition
 * from the catalog and labels it as such: privileges, triggers, policies, and
 * storage parameters are deliberately not included.
 */
export async function fetchTableDefinition(
  pool: Pool,
  schema: string,
  table: string,
  columns: ColumnInfo[],
): Promise<string> {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.contype, con.conname`,
    [schema, table],
  );

  const parts = columns.map((c) => {
    const nullable = c.nullable ? "" : " NOT NULL";
    const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : "";
    return `  ${c.name} ${c.columnType}${nullable}${def}`;
  });
  for (const r of rows) parts.push(`  ${String(r.definition)}`);

  return `-- reconstructed from the catalog; not a full pg_dump\nCREATE TABLE ${schema}.${table} (\n${parts.join(",\n")}\n);`;
}
