/** Data Viewer cell previews on both engines against the SSH fixture. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeSession, createSession, getSession } from "../server/core/session.ts";
import type { DatabaseEngine } from "#shared/types.ts";

const root = new URL("..", import.meta.url);
const sshPort = Number(readFileSync(new URL("fixture/.ssh-port", root), "utf8").trim());
const keyPath = fileURLToPath(new URL("fixture/ssh/id_ed25519", root));
process.env.DBSCOPE_KNOWN_HOSTS ??= fileURLToPath(new URL("fixture/.known_hosts", root));

const table = "verify_cell_preview";
const BLOB_BYTES = 1_000_000;
const prefix = "x".repeat(250);

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (!condition) throw new Error(`cell preview verification failed: ${label} ${detail}`);
  console.log(`  ✓ ${label}`);
}

const ddl: Record<DatabaseEngine, string[]> = {
  mysql: [
    `CREATE TABLE ${table} (id INT PRIMARY KEY, body LONGTEXT NOT NULL, meta JSON NOT NULL, avatar LONGBLOB NOT NULL)`,
    `INSERT INTO ${table} VALUES
       (1, CONCAT('${prefix}', 'a', REPEAT('y', 100000)), JSON_OBJECT('k', REPEAT('j', 5000)), REPEAT('b', ${BLOB_BYTES})),
       (2, CONCAT('${prefix}', 'z'), JSON_OBJECT('k', 1), REPEAT('b', 3))`,
  ],
  postgres: [
    `CREATE TABLE ${table} (id int PRIMARY KEY, body text NOT NULL, meta jsonb NOT NULL, avatar bytea NOT NULL)`,
    `INSERT INTO ${table} VALUES
       (1, '${prefix}' || 'a' || repeat('y', 100000), jsonb_build_object('k', repeat('j', 5000)), convert_to(repeat('b', ${BLOB_BYTES}), 'UTF8')),
       (2, '${prefix}' || 'z', jsonb_build_object('k', 1), convert_to(repeat('b', 3), 'UTF8'))`,
  ],
};

for (const engine of ["mysql", "postgres"] as const) {
  console.log(`\n${engine}`);
  const info = await createSession({
    engine,
    ssh: { host: "127.0.0.1", port: sshPort, user: "appuser", privateKey: keyPath },
    mysql: {
      host: engine,
      port: engine === "mysql" ? 3306 : 5432,
      user: "appuser",
      password: "apppass",
      database: "appdb",
    },
  });
  const { adapter, pool } = getSession(info.id);
  const run = (sql: string) => (pool as { query: (sql: string) => Promise<unknown> }).query(sql);

  try {
    await run(`DROP TABLE IF EXISTS ${table}`);
    for (const statement of ddl[engine]) await run(statement);

    const page = await adapter.fetchPage(pool, info.database, table, {
      orderBy: "body",
      orderDir: "desc",
    });
    const [first, second] = page.rows;
    const bytes = Buffer.byteLength(JSON.stringify(page));

    check("returns every column", page.columns.join() === "id,body,meta,avatar");
    check("truncates long text", String(first?.body).length === 200);
    check(
      "truncates JSON",
      String(first?.meta).length < 200 && String(second?.meta).length === 200,
    );
    check(
      "replaces binary with its size",
      first?.avatar === `<binary 3 B>` && second?.avatar === `<binary ${BLOB_BYTES} B>`,
      `${first?.avatar} / ${second?.avatar}`,
    );
    check(
      "sorts by the full value, not the preview",
      Number(first?.id) === 2,
      `first id=${first?.id}`,
    );
    check("keeps the page payload small", bytes < 2_000, `${bytes} bytes`);
  } finally {
    await run(`DROP TABLE IF EXISTS ${table}`);
    await closeSession(info.id);
  }
}

console.log(`\n${checks} cell preview checks passed`);
