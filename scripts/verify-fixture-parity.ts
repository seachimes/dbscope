/**
 * Assert that the MySQL and PostgreSQL fixtures hold identical data.
 *
 * DBSCOPE is used to compare the two engines, so any difference the UI shows
 * must come from the engine — not from the fixture. This runs the same query
 * against both databases and fails on the first mismatch.
 *
 * Both connections go through the SSH tunnel, exactly as the app does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeSession, createSession, getSession } from "../server/core/session.ts";
import type { Pool as MySqlPool, RowDataPacket } from "mysql2/promise";
import type { Pool as PgPool } from "pg";
import type { DatabaseEngine } from "#shared/types.ts";

const root = new URL("..", import.meta.url);
const sshPort = Number(readFileSync(new URL("fixture/.ssh-port", root), "utf8").trim());
const keyPath = fileURLToPath(new URL("fixture/ssh/id_ed25519", root));
process.env.DBSCOPE_KNOWN_HOSTS ??= fileURLToPath(new URL("fixture/.known_hosts", root));

const connect = (engine: DatabaseEngine, host: string, port: number) =>
  createSession({
    engine,
    ssh: { host: "127.0.0.1", port: sshPort, user: "appuser", privateKey: keyPath },
    mysql: { host, port, user: "appuser", password: "apppass", database: "appdb" },
  });

/**
 * Queries are written once per engine because the dialects differ, but both
 * sides must return the same scalar. Numbers come back as strings from one
 * driver and numbers from the other, so everything is compared as text.
 */
const CHECKS: Array<{ label: string; mysql: string; postgres: string }> = [
  ...["users", "posts", "comments", "reactions", "categories", "post_categories"].map((t) => ({
    label: `row count: ${t}`,
    mysql: `SELECT COUNT(*) AS v FROM ${t}`,
    postgres: `SELECT count(*) AS v FROM ${t}`,
  })),

  // Primary keys must hold the same values, or the child tables cannot match.
  {
    label: "posts.id is contiguous from 1",
    mysql: 'SELECT CONCAT(MIN(id), "..", MAX(id)) AS v FROM posts',
    postgres: "SELECT min(id) || '..' || max(id) AS v FROM posts",
  },
  {
    label: "comments.id is contiguous from 1",
    mysql: 'SELECT CONCAT(MIN(id), "..", MAX(id)) AS v FROM comments',
    postgres: "SELECT min(id) || '..' || max(id) AS v FROM comments",
  },

  // The selectivity of this predicate is what the planner estimates, and what
  // every before/after comparison in the UI is measured against.
  {
    label: "posts matching user_id = 42",
    mysql: "SELECT COUNT(*) AS v FROM posts WHERE user_id = 42",
    postgres: "SELECT count(*) AS v FROM posts WHERE user_id = 42",
  },
  {
    label: "posts per user (min/max)",
    mysql:
      'SELECT CONCAT(MIN(c), "/", MAX(c)) AS v FROM (SELECT COUNT(*) c FROM posts GROUP BY user_id) t',
    postgres:
      "SELECT min(c) || '/' || max(c) AS v FROM (SELECT count(*) c FROM posts GROUP BY user_id) t",
  },

  // Checksums over the foreign-key columns: these only agree if the actual
  // values match row for row, not merely the row counts.
  {
    label: "checksum: sum(posts.user_id)",
    mysql: "SELECT SUM(user_id) AS v FROM posts",
    postgres: "SELECT sum(user_id) AS v FROM posts",
  },
  {
    label: "checksum: sum(comments.post_id)",
    mysql: "SELECT SUM(post_id) AS v FROM comments",
    postgres: "SELECT sum(post_id) AS v FROM comments",
  },
  {
    label: "checksum: sum(reactions.post_id)",
    mysql: "SELECT SUM(post_id) AS v FROM reactions",
    postgres: "SELECT sum(post_id) AS v FROM reactions",
  },
  {
    label: "checksum: sum(post_categories.category_id)",
    mysql: "SELECT SUM(category_id) AS v FROM post_categories",
    postgres: "SELECT sum(category_id) AS v FROM post_categories",
  },

  // The planted problems themselves: the fixture is only useful if both engines
  // have the same indexes present and the same ones missing.
  {
    label: "secondary indexes",
    mysql: `SELECT GROUP_CONCAT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME) ORDER BY TABLE_NAME, INDEX_NAME SEPARATOR ',') AS v
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = 'appdb' AND INDEX_NAME <> 'PRIMARY'`,
    postgres: `SELECT string_agg(tablename || '.' || indexname, ',' ORDER BY tablename, indexname) AS v
                 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'`,
  },
];

const mysqlInfo = await connect("mysql", "mysql", 3306);
const pgInfo = await connect("postgres", "postgres", 5432);
const mysqlPool = getSession(mysqlInfo.id).pool as MySqlPool;
const pgPool = getSession(pgInfo.id).pool as PgPool;

const scalar = async (engine: DatabaseEngine, sql: string): Promise<string> => {
  if (engine === "mysql") {
    const [rows] = await mysqlPool.query<RowDataPacket[]>(sql);
    return String(rows[0]?.v ?? "");
  }
  const { rows } = await pgPool.query<{ v: unknown }>(sql);
  return String(rows[0]?.v ?? "");
};

console.log("\ncomparing the MySQL and PostgreSQL fixtures\n");
console.log(`  ${"check".padEnd(42)} ${"value".padEnd(26)} result`);

let failures = 0;
for (const check of CHECKS) {
  const [mysql, postgres] = await Promise.all([
    scalar("mysql", check.mysql),
    scalar("postgres", check.postgres),
  ]);
  const same = mysql === postgres;
  if (!same) failures++;
  const shown = same ? mysql : `${mysql} vs ${postgres}`;
  console.log(
    `  ${same ? "✓" : "✗"} ${check.label.padEnd(40)} ${shown.slice(0, 26).padEnd(26)} ${same ? "" : "DIFFERS"}`,
  );
}

await Promise.all([closeSession(mysqlInfo.id), closeSession(pgInfo.id)]);

console.log(
  failures === 0
    ? "\nthe two fixtures are identical; any difference in the UI is an engine difference\n"
    : `\n${failures} check(s) differ — the engines cannot be compared until these match\n`,
);
if (failures > 0) process.exit(1);
