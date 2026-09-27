/** Native PostgreSQL Data Viewer filter checks against the SSH fixture. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { closeSession, createSession, getSession } from "../server/core/session.ts";
import { fetchPage } from "../server/database/postgres/data.ts";

const root = new URL("..", import.meta.url);
const sshPort = Number(readFileSync(new URL("fixture/.ssh-port", root), "utf8").trim());
const keyPath = fileURLToPath(new URL("fixture/ssh/id_ed25519", root));
process.env.DBSCOPE_KNOWN_HOSTS ??= fileURLToPath(new URL("fixture/.known_hosts", root));

let checks = 0;
function check(label: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`filter verification failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

const info = await createSession({
  engine: "postgres",
  ssh: { host: "127.0.0.1", port: sshPort, user: "appuser", privateKey: keyPath },
  mysql: { host: "postgres", port: 5432, user: "appuser", password: "apppass", database: "appdb" },
});
const { pool } = getSession(info.id);
const pgPool = pool as Pool;
const table = "verify_native_filters";
let selectedSql = "";
// Forward to the real SSH-backed pool while observing the actual SELECT issued
// by fetchPage; result checks alone would not catch a future indexed-column cast.
const observedPool = {
  query: (...args: Parameters<Pool["query"]>) => pgPool.query(...args),
  connect: async () => {
    const client = await pgPool.connect();
    return {
      query: (...args: Parameters<typeof client.query>) => {
        if (typeof args[0] === "string" && args[0].startsWith("SELECT * FROM")) {
          selectedSql = args[0];
        }
        return client.query(...args);
      },
      release: () => client.release(),
    };
  },
} as unknown as Pool;

try {
  await pgPool.query(`DROP TABLE IF EXISTS ${table}`);
  await pgPool.query(`CREATE TABLE ${table} (
    amount numeric NOT NULL, label text NOT NULL, active boolean, recorded_at date
  )`);
  await pgPool.query(`CREATE INDEX ${table}_amount_idx ON ${table} (amount)`);
  await pgPool.query(`INSERT INTO ${table} VALUES
    (2, '10%_\\demo', true, '2024-01-02'),
    (10, '2', false, '2024-01-10'),
    (20, 'other', NULL, NULL)`);

  const filter = (
    column: string,
    operator: "eq" | "gt" | "lt" | "contains" | "starts_with" | "is_null",
    value?: string,
  ) =>
    fetchPage(observedPool, "public", table, {
      filter: { column, operator, value },
      orderBy: "amount",
      pageSize: 20,
    });
  const amounts = (rows: Array<Record<string, unknown>>) => rows.map((row) => Number(row.amount));

  check(
    "numeric > 2 uses numeric order, not text order",
    JSON.stringify(amounts((await filter("amount", "gt", "2")).rows)) === "[10,20]",
  );
  check(
    "comparison casts the parameter instead of indexed column",
    /"amount" > \$1::"pg_catalog"\."numeric"/.test(selectedSql) &&
      !selectedSql.includes('"amount"::text'),
  );
  check(
    "numeric < 10 includes 2",
    JSON.stringify(amounts((await filter("amount", "lt", "10")).rows)) === "[2]",
  );
  check(
    "native numeric equality matches decimal input",
    JSON.stringify(amounts((await filter("amount", "eq", "02.00")).rows)) === "[2]",
  );
  check(
    "native dates compare chronologically",
    JSON.stringify(amounts((await filter("recorded_at", "gt", "2024-01-02")).rows)) === "[10]",
  );
  check(
    "boolean equality remains available",
    JSON.stringify(amounts((await filter("active", "eq", "true")).rows)) === "[2]",
  );
  check(
    "text contains still supports literal wildcard characters",
    JSON.stringify(amounts((await filter("label", "contains", "%_\\")).rows)) === "[2]",
  );
  check(
    "text starts_with still works",
    JSON.stringify(amounts((await filter("label", "starts_with", "oth")).rows)) === "[20]",
  );
  check(
    "null filter works without a value",
    JSON.stringify(amounts((await filter("active", "is_null")).rows)) === "[20]",
  );

  async function rejects(
    label: string,
    run: () => Promise<unknown>,
    expected: RegExp,
  ): Promise<void> {
    try {
      await run();
      throw new Error(`${label}: filter unexpectedly succeeded`);
    } catch (error) {
      check(label, expected.test(String(error)));
    }
  }
  await rejects(
    "rejects LIKE on numeric columns with guidance",
    () => filter("amount", "contains", "2"),
    /requires a text column.*Use eq\/ne/,
  );
  await rejects(
    "rejects boolean ordering with guidance",
    () => filter("active", "gt", "false"),
    /not supported.*use is_null\/is_not_null/,
  );
  await rejects(
    "rejects invalid numeric input instead of text comparison",
    () => filter("amount", "eq", "not-a-number"),
    /invalid input syntax for type numeric/,
  );
  console.log(`\n${checks} PostgreSQL filter checks passed`);
} finally {
  await pgPool.query(`DROP TABLE IF EXISTS ${table}`);
  await closeSession(info.id);
}
