/**
 * PostgreSQL identifier quoting and result-shape normalization.
 *
 * Identifiers can never be bound as parameters, so every identifier that
 * reaches SQL is validated against the catalog first and quoted here. Double
 * quotes are escaped by doubling, which is the only escape PostgreSQL defines.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 63 || name.includes("\0")) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully qualified `"schema"."object"`. */
export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Normalize a value that should be a text array.
 *
 * node-postgres only parses array types it has a registered parser for. A
 * catalog column of type `name[]` (OID 1003) has no parser, so it arrives as
 * the raw literal `{id,user_id}` instead of an array. Catalog queries cast to
 * `text[]` to avoid this, but normalizing here as well means a driver or
 * server-version difference degrades into readable data rather than a UI crash
 * on `columns.join is not a function`.
 */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return [];
  const raw = String(value);
  if (!raw.startsWith("{") || !raw.endsWith("}")) return raw ? [raw] : [];

  const out: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of raw.slice(1, -1)) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.length > 0 || out.length > 0) out.push(current);
  return out.filter((v) => v.length > 0);
}

/** PostgreSQL returns bigint/numeric as strings to preserve precision. */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
