/**
 * Engine-agnostic adapter smoke test for CI.
 *
 * Connects directly (no SSH) to a database supplied through environment
 * variables, creates a small schema, and asserts that the adapter reports the
 * shapes the UI depends on. Runs against MySQL and PostgreSQL unchanged, so a
 * regression in either adapter fails the build.
 *
 *   DBSCOPE_ENGINE=postgres DBSCOPE_DB_HOST=127.0.0.1 \
 *   DBSCOPE_DB_USER=appuser DBSCOPE_DB_PASSWORD=apppass \
 *   DBSCOPE_DB_NAME=appdb pnpm tsx scripts/smoke-adapter.ts
 */
import { closeSession, createSession, getSession } from "../server/core/session.ts";
import type { DatabaseEngine } from "#shared/types.ts";

const engine = (process.env.DBSCOPE_ENGINE ?? "mysql") as DatabaseEngine;
const defaultPort = engine === "postgres" ? 5432 : 3306;

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`\nDBSCOPE adapter smoke test (${engine})\n`);

const info = await createSession({
  engine,
  ssh: null,
  mysql: {
    host: process.env.DBSCOPE_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DBSCOPE_DB_PORT ?? defaultPort),
    user: process.env.DBSCOPE_DB_USER ?? "appuser",
    password: process.env.DBSCOPE_DB_PASSWORD ?? "apppass",
    database: process.env.DBSCOPE_DB_NAME ?? "appdb",
  },
});

const session = getSession(info.id);
const { adapter, pool } = session;
const sql = (text: string) =>
  (pool as unknown as { query: (q: string) => Promise<unknown> }).query(text);

check("connects and reports the requested engine", info.engine === engine);
check("reports a server version", info.mysqlVersion.length > 0, info.mysqlVersion);

// A tiny schema is enough to exercise every catalog path the UI reads.
const serialPk =
  engine === "postgres" ? "bigserial PRIMARY KEY" : "BIGINT AUTO_INCREMENT PRIMARY KEY";
await sql("DROP TABLE IF EXISTS smoke_child");
await sql("DROP TABLE IF EXISTS smoke_parent");
await sql(`CREATE TABLE smoke_parent (id ${serialPk}, name VARCHAR(64) NOT NULL)`);
await sql(
  `CREATE TABLE smoke_child (
     id ${serialPk},
     parent_id BIGINT NOT NULL,
     label VARCHAR(64) NOT NULL,
     CONSTRAINT fk_smoke_child_parent FOREIGN KEY (parent_id) REFERENCES smoke_parent (id)
   )`,
);
await sql("INSERT INTO smoke_parent (name) VALUES ('a'), ('b')");
await sql("INSERT INTO smoke_child (parent_id, label) VALUES (1, 'x'), (1, 'y'), (2, 'z')");
await sql("CREATE INDEX idx_smoke_child_pair ON smoke_child (parent_id, label)");

try {
  console.log("\noverview");
  const overview = await adapter.overview(pool, session.info);
  const names = overview.tables.map((t) => t.name);
  check(
    "lists both tables",
    names.includes("smoke_parent") && names.includes("smoke_child"),
    names.join(","),
  );
  check(
    "reads the declared foreign key",
    overview.relations.some((r) => r.fromTable === "smoke_child" && r.toTable === "smoke_parent"),
  );

  console.log("\nindexes");
  const indexes = await adapter.listIndexes(pool, session.info.database, "smoke_child");
  // Guards the driver-level bug where an unparsed array crashed the UI.
  check(
    "returns columns as arrays",
    indexes.every((i) => Array.isArray(i.columns)),
    JSON.stringify(indexes.map((i) => i.columns)),
  );
  const composite = indexes.find((i) => i.name === "idx_smoke_child_pair");
  check(
    "keeps a composite index as one entry in key order",
    composite?.columns.length === 2 && composite.columns[0] === "parent_id",
    JSON.stringify(composite?.columns),
  );
  check(
    "identifies the primary key",
    indexes.some((i) => i.isPrimary),
  );

  console.log("\ntable detail and data");
  const detail = await adapter.tableDetail(pool, session.info, "smoke_child");
  check("lists columns", detail.columns.length === 3, `${detail.columns.length} columns`);
  check("returns a table definition", detail.createStatement.length > 0);

  const page = await adapter.fetchPage(pool, session.info.database, "smoke_child", {
    pageSize: 2,
    orderBy: "id",
    orderDir: "desc",
  });
  check("pages rows", page.rows.length === 2, `${page.rows.length} rows`);
  check("reports the ordering it applied", page.orderBy === "id" && page.orderDir === "desc");

  const filtered = await adapter.fetchPage(pool, session.info.database, "smoke_child", {
    filter: { column: "parent_id", operator: "eq", value: "1" },
  });
  check("applies a bound filter", filtered.rows.length === 2, `${filtered.rows.length} rows`);

  console.log("\nexplain");
  const plan = await adapter.explain(
    pool,
    session.info.database,
    "SELECT id, label FROM smoke_child WHERE parent_id = 1",
    {},
  );
  check("produces plan steps", plan.steps.length > 0);
  check(
    "every step carries a label",
    plan.steps.every((s) => s.label.length > 0),
  );

  console.log("\nsafety");
  for (const [label, statement] of [
    ["refuses a DELETE", "DELETE FROM smoke_child WHERE id = 1"],
    ["refuses stacked statements", "SELECT 1; DROP TABLE smoke_child"],
  ] as const) {
    try {
      await adapter.explain(pool, session.info.database, statement, {});
      check(label, false, "was allowed");
    } catch {
      check(label, true);
    }
  }

  try {
    await adapter.fetchPage(pool, session.info.database, "smoke_child", {
      filter: { column: "id; DROP TABLE smoke_child", operator: "eq", value: "1" },
    });
    check("rejects a hostile filter column", false, "was allowed");
  } catch {
    check("rejects a hostile filter column", true);
  }
} finally {
  await sql("DROP TABLE IF EXISTS smoke_child").catch(() => {});
  await sql("DROP TABLE IF EXISTS smoke_parent").catch(() => {});
  await closeSession(info.id);
}

console.log(failures === 0 ? "\nall adapter checks passed\n" : `\n${failures} check(s) failed\n`);
if (failures > 0) process.exit(1);
