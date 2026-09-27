/**
 * PostgreSQL verification against the Docker fixture, through a real SSH tunnel.
 *
 * Asserts the things that must hold for the PostgreSQL adapter to be
 * trustworthy: catalog shapes are real arrays, plans are interpreted in
 * PostgreSQL's own vocabulary, index DDL is safe, and constraint-owned indexes
 * are refused, including standalone UNIQUE indexes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeSession, createSession, getSession } from "../server/core/session.ts";

const root = new URL("..", import.meta.url);
const sshPort = Number(readFileSync(new URL("fixture/.ssh-port", root), "utf8").trim());
const keyPath = fileURLToPath(new URL("fixture/ssh/id_ed25519", root));

// Verify against the fixture's recorded host key, so this exercises the same
// checked path a real connection takes rather than the insecure opt-out.
process.env.DBSCOPE_KNOWN_HOSTS ??= fileURLToPath(new URL("fixture/.known_hosts", root));

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nDBSCOPE PostgreSQL verification\n");
console.log("connection");

const info = await createSession({
  engine: "postgres",
  ssh: { host: "127.0.0.1", port: sshPort, user: "appuser", privateKey: keyPath },
  mysql: { host: "postgres", port: 5432, user: "appuser", password: "apppass", database: "appdb" },
});
const session = getSession(info.id);
const { adapter, pool } = session;

check("connects to PostgreSQL through the SSH tunnel", info.viaSsh && info.mysqlVersion.length > 0);
check("reports the postgres engine", info.engine === "postgres");
check("detects pg_stat_statements", info.performanceSchema.digestEnabled);

console.log("\noverview");
const overview = await adapter.overview(pool, session.info);
const posts = overview.tables.find((t) => t.name === "posts");
check("reads every table", overview.tables.length >= 3, `found ${overview.tables.length}`);
check("estimates posts rows", (posts?.rows ?? 0) > 1000, `rows=${posts?.rows}`);
check(
  "reads declared foreign keys",
  overview.relations.some((r) => r.kind === "foreign_key"),
);
check(
  "flags posts.user_id as an unindexed join",
  overview.relations.some(
    (r) => r.fromTable === "posts" && r.fromColumn === "user_id" && r.unindexed,
  ),
);

console.log("\nindexes");
const indexes = await adapter.listIndexes(pool, session.info.database, "comments");
// The bug this guards: name[] arrives unparsed from the driver, so columns was
// the string "{post_id}" and the Indexes tab crashed on columns.join.
check(
  "returns index columns as arrays",
  indexes.every((i) => Array.isArray(i.columns)),
);
check(
  "every index has at least one key column",
  indexes.every((i) => i.columns.length > 0),
);
check(
  "identifies the primary key",
  indexes.some((i) => i.isPrimary),
);

const pgPool = pool as unknown as { query: (sql: string, values?: unknown[]) => Promise<unknown> };
await pgPool.query("CREATE INDEX IF NOT EXISTS verify_multi ON posts (user_id, created_at DESC)");
const multi = (await adapter.listIndexes(pool, session.info.database, "posts")).find(
  (i) => i.name === "verify_multi",
);
check(
  "keeps a composite index as one entry in key order",
  multi?.columns.length === 2 && multi.columns[0] === "user_id",
  JSON.stringify(multi?.columns),
);
await pgPool.query("DROP INDEX IF EXISTS verify_multi");

console.log("\ntable detail and data");
const detail = await adapter.tableDetail(pool, session.info, "posts");
check("lists columns", detail.columns.length >= 4);
check("reconstructs a labeled definition", detail.createStatement.includes("CREATE TABLE"));

const page = await adapter.fetchPage(pool, session.info.database, "posts", {
  page: 1,
  pageSize: 5,
  orderBy: "id",
  orderDir: "desc",
});
check("pages through rows", page.rows.length === 5, `got ${page.rows.length}`);
check(
  "sorts by the requested column",
  Number((page.rows[0] as { id: number }).id) > Number((page.rows[4] as { id: number }).id),
);

const filtered = await adapter.fetchPage(pool, session.info.database, "posts", {
  pageSize: 5,
  filter: { column: "user_id", operator: "eq", value: "42" },
});
check(
  "applies a bound filter",
  filtered.rows.every((r) => Number((r as { user_id: number }).user_id) === 42),
);

console.log("\nexplain");
const slow = "SELECT id FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20";
const before = await adapter.explain(pool, session.info.database, slow, {});
check(
  "detects the sequential scan",
  before.steps.some((s) => s.kind === "full_scan"),
);
check(
  "reports it as an issue",
  before.issues.some((i) => i.code === "FULL_SCAN"),
);
check("keeps the native plan JSON", before.json !== null);

const analyzed = await adapter.explain(pool, session.info.database, slow, { analyze: true });
check("runs EXPLAIN ANALYZE", analyzed.analyze !== null);

// PostgreSQL reports rows emitted, not rows read. A scan that returns 25 rows
// out of 50,000 must be reported as the 50,000 it actually reads.
const scan = before.steps.find((s) => s.kind === "full_scan");
check("counts the rows the scan really reads", (scan?.rows ?? 0) > 10_000, `rows=${scan?.rows}`);
check("suggests an index", before.suggestions.length > 0);
check(
  "suggests (user_id, created_at) in that order",
  before.suggestions[0]?.columns.join(",") === "user_id,created_at",
  before.suggestions[0]?.columns.join(","),
);
check("suggests non-blocking DDL", before.suggestions[0]?.ddl.includes("CONCURRENTLY") === true);

console.log("\nimprovement loop");
const created = await adapter.createIndex(pool, session.info.database, {
  table: "posts",
  name: "verify_posts_user_created",
  columns: ["user_id", "created_at"],
});
check("creates the index concurrently", created.ok && created.ddl.includes("CONCURRENTLY"));

const after = await adapter.explain(pool, session.info.database, slow, {});
check(
  "no longer scans the table",
  !after.steps.some((s) => s.kind === "full_scan"),
  after.steps.map((s) => s.label).join(","),
);
check("no remaining full-scan issue", !after.issues.some((i) => i.code === "FULL_SCAN"));

// The verdict must show a real improvement. This was silently always "no
// change" while the row metric was read from the empty tabular EXPLAIN.
const widest = (p: typeof after) => p.steps.reduce((acc, s) => Math.max(acc, s.rows ?? 0), 0);
check(
  "reports far fewer rows after the index",
  widest(after) * 10 < widest(before),
  `${widest(before)} -> ${widest(after)}`,
);

const dropped = await adapter.dropIndex(
  pool,
  session.info.database,
  "posts",
  "verify_posts_user_created",
);
check("drops the index again", dropped.ok);

console.log("\nsafety");
const refused = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    check(label, false, "was allowed");
  } catch {
    check(label, true);
  }
};

await refused("refuses to explain a DELETE", () =>
  adapter.explain(pool, session.info.database, "DELETE FROM posts WHERE id = 1", {}),
);
await refused("refuses stacked statements", () =>
  adapter.explain(pool, session.info.database, "SELECT 1; DROP TABLE posts", {}),
);
await refused("refuses to drop a constraint-backed index", () =>
  adapter.dropIndex(pool, session.info.database, "users", "users_pkey"),
);

// A standalone UNIQUE index has no owning constraint, yet still enforces a
// data guarantee. Refusing the drop must leave that guarantee intact.
await pgPool.query("CREATE TABLE verify_unique_index_guard (value integer NOT NULL)");
try {
  await pgPool.query(
    "CREATE UNIQUE INDEX verify_standalone_unique ON verify_unique_index_guard (value)",
  );
  await pgPool.query("INSERT INTO verify_unique_index_guard (value) VALUES (42)");
  const ownership = await (
    pool as unknown as {
      query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ owned: boolean }> }>;
    }
  ).query(`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = $1::regclass) AS owned`, [
    "public.verify_standalone_unique",
  ]);
  check("test UNIQUE index is not constraint-backed", ownership.rows[0]?.owned === false);

  let dropError: unknown;
  try {
    await adapter.dropIndex(
      pool,
      session.info.database,
      "verify_unique_index_guard",
      "verify_standalone_unique",
    );
  } catch (error) {
    dropError = error;
  }
  check(
    "refuses to drop a standalone UNIQUE index",
    dropError instanceof Error && /UNIQUE index/.test(dropError.message),
    dropError instanceof Error ? dropError.message : "drop was allowed",
  );

  let duplicateError: unknown;
  try {
    await pgPool.query("INSERT INTO verify_unique_index_guard (value) VALUES (42)");
  } catch (error) {
    duplicateError = error;
  }
  check(
    "standalone UNIQUE index still forbids duplicates after refused drop",
    (duplicateError as { code?: string } | undefined)?.code === "23505",
    duplicateError instanceof Error ? duplicateError.message : "duplicate was allowed",
  );
} finally {
  await pgPool.query("DROP TABLE verify_unique_index_guard");
}

await refused("rejects an unknown filter column", () =>
  adapter.fetchPage(pool, session.info.database, "posts", {
    filter: { column: "id; DROP TABLE posts", operator: "eq", value: "1" },
  }),
);

// A read-only transaction must have rolled back: the row must still be there.
const stillThere = await adapter.fetchPage(pool, session.info.database, "posts", { pageSize: 1 });
check("EXPLAIN never committed anything", stillThere.rows.length === 1);

// An advisory lock lives on the connection, not the transaction, so ROLLBACK
// alone leaves it held and it would ride a pooled connection into later work.
await adapter.explain(pool, session.info.database, "SELECT pg_advisory_lock(4242)", {
  analyze: true,
});
const locks = await (
  pool as unknown as {
    query: (sql: string) => Promise<{ rows: Array<{ c: string }> }>;
  }
).query("SELECT count(*) AS c FROM pg_locks WHERE locktype = 'advisory'");
check(
  "EXPLAIN ANALYZE leaves no session state behind",
  Number(locks.rows[0]?.c ?? 0) === 0,
  `${locks.rows[0]?.c} advisory lock(s) still held`,
);

await closeSession(info.id);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
