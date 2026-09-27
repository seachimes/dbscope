/**
 * Engine-independent SQL checks shared by both EXPLAIN implementations: the
 * read-only guard, and the column extraction that index suggestions build on.
 */

/**
 * Only read-only statements may be EXPLAINed. EXPLAIN on an UPDATE/DELETE is
 * valid SQL, but this tool can be pointed at a live database, and the blast
 * radius of a mistyped statement is not worth the feature.
 */
const READ_ONLY = /^\s*(SELECT|WITH)\b/i;
const UNSAFE_READ =
  /\b(SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i;
const MAX_SQL_LENGTH = 100_000;

export function assertExplainable(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!READ_ONLY.test(trimmed)) {
    throw new Error("only SELECT / WITH statements can be explained");
  }
  // A WITH statement must ultimately feed a SELECT, never UPDATE/DELETE. This
  // is conservative lexical defense; the database rejects anything else.
  if (/^\s*WITH\b/i.test(trimmed) && /\)\s*(UPDATE|DELETE|INSERT|REPLACE)\b/i.test(trimmed)) {
    throw new Error("writable CTEs are not allowed");
  }
  if (trimmed.length > MAX_SQL_LENGTH) throw new Error("SQL is too long");
  // One statement at a time: a `;` followed by more text is a second statement.
  if (/;/.test(trimmed)) throw new Error("only one statement at a time");
  if (UNSAFE_READ.test(trimmed)) {
    throw new Error("locking, delay, and file-output constructs are not allowed");
  }
}

/**
 * Pull `col = ?` / `col IN (...)` column names out of the SQL.
 *
 * A real parser would be better, but a dependency-free regex over the WHERE
 * clause covers the shapes that matter in practice and never blocks the rest
 * of the feature when it fails to match.
 */
export function extractEqualityColumns(sql: string, table: string): string[] {
  const where = /\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(sql);
  if (!where?.[1]) return [];

  const alias = findAlias(sql, table);
  const cols: string[] = [];
  const re = /([`\w.]+)\s*(?:=|IN\s*\(|<=>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(where[1])) !== null) {
    const ref = stripQuotes(m[1] ?? "");
    if (!ref) continue;
    const dot = ref.indexOf(".");
    if (dot >= 0) {
      const qualifier = ref.slice(0, dot);
      // Skip columns that clearly belong to a different table.
      if (qualifier !== table && qualifier !== alias) continue;
      cols.push(ref.slice(dot + 1));
    } else {
      cols.push(ref);
    }
  }
  return cols.filter((c) => /^\w+$/.test(c));
}

export function extractOrderColumns(sql: string): string[] {
  const order = /\bORDER\s+BY\b([\s\S]*?)(\bLIMIT\b|$)/i.exec(sql);
  if (!order?.[1]) return [];
  return order[1]
    .split(",")
    .map((part) => stripQuotes(part.trim().split(/\s+/)[0] ?? ""))
    .map((ref) => (ref.includes(".") ? ref.slice(ref.indexOf(".") + 1) : ref))
    .filter((c) => /^\w+$/.test(c));
}

function findAlias(sql: string, table: string): string | null {
  const re = new RegExp(`\`?${table}\`?\\s+(?:AS\\s+)?(\\w+)`, "i");
  const m = re.exec(sql);
  const candidate = m?.[1];
  if (!candidate) return null;
  // `FROM posts WHERE` would otherwise read WHERE as the alias.
  if (/^(where|on|join|left|right|inner|outer|group|order|limit|set|using)$/i.test(candidate)) {
    return null;
  }
  return candidate;
}

function stripQuotes(s: string): string {
  return s.replace(/`/g, "").trim();
}
