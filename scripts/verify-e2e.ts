/**
 * End-to-end verification against the Docker fixture, through a real SSH tunnel.
 *
 * Exercises the server the way the UI does, and asserts on the things that must
 * be true for the tool to be trustworthy: that it finds the planted problems,
 * that an index actually fixes them, and that it cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeSession, createSession, getSession } from "../server/core/session.ts";
import { buildOverview, buildTableDetail } from "../server/database/mysql/overview.ts";
import { runExplain, suggestIndexes } from "../server/database/mysql/explain.ts";
import { createIndex, dropIndex, fetchPage, listIndexes } from "../server/database/mysql/data.ts";
import { fetchIndexes } from "../server/database/mysql/introspect.ts";
import { fetchQueryStats } from "../server/database/mysql/queries.ts";
import type { Pool } from "mysql2/promise";

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

console.log("\nDBSCOPE end-to-end verification\n");

console.log("connection");
const info = await createSession({
  ssh: { host: "127.0.0.1", port: sshPort, user: "appuser", privateKey: keyPath },
  mysql: { host: "mysql", port: 3306, user: "appuser", password: "apppass", database: "appdb" },
});
check("connects to MySQL through the SSH tunnel", info.viaSsh && info.mysqlVersion.length > 0);
check("detects EXPLAIN ANALYZE support on 8.0", info.supportsExplainAnalyze);
check("detects performance_schema", info.performanceSchema.digestEnabled);

const session = getSession(info.id);
const pool = session.pool as Pool;

console.log("\noverview");
const overview = await buildOverview(pool, info);
check("finds all 6 tables", overview.tables.length === 6, `found ${overview.tables.length}`);
check("estimates ~1M rows total", overview.totals.rowCount > 900_000);

const posts = overview.tables.find((t) => t.name === "posts");
const categories = overview.tables.find((t) => t.name === "categories");
check("ranks posts as the hottest table", overview.tables[0]?.name === "posts");
check("gives posts a high heat score", (posts?.heat ?? 0) > 70, `heat=${posts?.heat}`);
check(
  "leaves the small healthy table cold",
  (categories?.heat ?? 100) < 25,
  `heat=${categories?.heat}`,
);

// The fixture declares exactly one FK; everything else must be inferred.
const fkCount = overview.relations.filter((r) => r.kind === "foreign_key").length;
const inferred = overview.relations.filter((r) => r.kind === "inferred").length;
check("reads the one declared foreign key", fkCount === 1, `found ${fkCount}`);
check("infers relations where no FK exists", inferred >= 5, `inferred ${inferred}`);
check(
  "flags posts.user_id as an unindexed join",
  overview.relations.some(
    (r) => r.fromTable === "posts" && r.fromColumn === "user_id" && r.unindexed,
  ),
);
check(
  "does NOT flag the indexed reactions.post_id",
  overview.relations.some(
    (r) => r.fromTable === "reactions" && r.fromColumn === "post_id" && !r.unindexed,
  ),
);
check(
  "reports the missing index on the biggest table",
  overview.issues.some((i) => i.table === "comments" && i.severity === "critical"),
);

console.log("\nquery statistics");
const stats = await fetchQueryStats(
  pool,
  "appdb",
  overview.tables.map((t) => t.name),
);
check("collects query digests", stats.length > 0, `${stats.length} digests`);
check(
  "ranks by total time, highest first",
  stats.every((q, i) => i === 0 || stats[i - 1]!.totalTimeMs >= q.totalTimeMs),
);
check(
  "excludes DDL from application load",
  !stats.some((q) => /^ALTER|^CREATE|^DROP/i.test(q.digestText)),
);
check(
  "attributes queries to tables",
  stats.some((q) => q.tables.includes("posts")),
);
check(
  "detects queries that read far more than they return",
  stats.some((q) => q.examinedPerSent > 100),
);

console.log("\ntable detail");
const detail = await buildTableDetail(pool, info, "posts");
check("lists all columns", detail.columns.length === 5, `${detail.columns.length} columns`);
check("returns SHOW CREATE TABLE", detail.createStatement.includes("CREATE TABLE"));
check("has only the primary key before tuning", detail.indexes.length === 1);

const page = await fetchPage(pool, "appdb", "posts", {
  pageSize: 10,
  orderBy: "id",
  orderDir: "desc",
});
check("pages through data", page.rows.length === 10);
check("sorts by the requested column", page.orderBy === "id" && page.orderDir === "desc");

console.log("\nexplain");
const SQL =
  "SELECT id, user_id, body FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20";
const before = await runExplain(pool, SQL, { supportsAnalyze: true, analyze: true });
check("detects the full scan", before.rows[0]?.type === "ALL");
check(
  "shows FULL SCAN in the plan flow",
  before.steps.some((s) => s.kind === "full_scan"),
);
check(
  "shows FILESORT in the plan flow",
  before.steps.some((s) => s.kind === "filesort"),
);
check("runs EXPLAIN ANALYZE", Boolean(before.analyze?.includes("actual time")));

const idx = await fetchIndexes(pool, "appdb");
const suggestions = suggestIndexes(before, idx);
const best = suggestions[0];
check("suggests an index", suggestions.length > 0);
check(
  "suggests (user_id, created_at) in that order",
  best?.columns.join(",") === "user_id,created_at",
  best?.columns.join(","),
);

console.log("\nimprovement loop");
await createIndex(pool, "appdb", { table: "posts", columns: ["user_id", "created_at"] });
const after = await runExplain(pool, SQL, { supportsAnalyze: true });
check(
  "uses the new index",
  after.rows[0]?.key === "idx_user_id_created_at",
  String(after.rows[0]?.key),
);
check("no longer scans the table", after.rows[0]?.type !== "ALL");
check("no longer sorts", !after.steps.some((s) => s.kind === "filesort"));
check(
  "examines far fewer rows",
  (after.rows[0]?.rows ?? Infinity) < (before.rows[0]?.rows ?? 0) / 100,
  `${before.rows[0]?.rows} -> ${after.rows[0]?.rows}`,
);
check("reports no remaining problems", after.issues.length === 0, `${after.issues.length} left`);

const withIndex = await listIndexes(pool, "appdb", "posts");
check(
  "lists the new index",
  withIndex.some((i) => i.name === "idx_user_id_created_at"),
);

await dropIndex(pool, "appdb", "posts", "idx_user_id_created_at");
const restored = await listIndexes(pool, "appdb", "posts");
check("drops the index again", restored.length === 1);

console.log("\nsafety");
await runExplain(pool, "DELETE FROM posts WHERE id = 1")
  .then(() => check("refuses to explain a DELETE", false))
  .catch(() => check("refuses to explain a DELETE", true));
await runExplain(pool, "SELECT 1; DROP TABLE posts")
  .then(() => check("refuses stacked statements", false))
  .catch(() => check("refuses stacked statements", true));
// A UNIQUE index is a data guarantee: dropping it from a performance screen
// would silently make duplicate rows insertable.
await dropIndex(pool, "appdb", "users", "uniq_account_name")
  .then(() => check("refuses to drop a UNIQUE constraint", false, "was allowed"))
  .catch(() => check("refuses to drop a UNIQUE constraint", true));

await dropIndex(pool, "appdb", "posts", "PRIMARY")
  .then(() => check("refuses to drop the PRIMARY KEY", false))
  .catch(() => check("refuses to drop the PRIMARY KEY", true));
await fetchPage(pool, "appdb", "posts", {
  filter: { column: "id", operator: "eq", value: "1; DROP TABLE posts" },
})
  .then(() => check("binds hostile filter values instead of executing them", true))
  .catch(() => check("binds hostile filter values instead of executing them", false));
await fetchPage(pool, "appdb", "posts", {
  filter: { column: "id; DROP TABLE posts", operator: "eq", value: "1" },
})
  .then(() => check("rejects hostile filter columns", false))
  .catch(() => check("rejects hostile filter columns", true));
await runExplain(pool, "SELECT SLEEP(10)")
  .then(() => check("rejects delay functions", false))
  .catch(() => check("rejects delay functions", true));

// Every MySQL reset method is server-wide, so the adapter must refuse rather
// than erase other databases' statistics.
await session.adapter
  .resetQueryStats(pool)
  .then(() => check("refuses a server-wide statistics reset", false, "reset ran"))
  .catch(() => check("refuses a server-wide statistics reset", true));
const afterReset = await fetchQueryStats(
  pool,
  "appdb",
  overview.tables.map((t) => t.name),
);
check(
  "keeps existing query statistics",
  afterReset.length >= stats.length,
  `${stats.length} → ${afterReset.length}`,
);

await closeSession(info.id);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures > 0 ? 1 : 0);
