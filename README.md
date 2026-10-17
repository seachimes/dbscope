# DBSCOPE

**Database performance inspector for MySQL and PostgreSQL.** Connect it to a
database and see where its time is going.

DBSCOPE focuses on one question: *"which part of this database is consuming the
most time, and what should I investigate next?"* — without manually assembling
schema metadata, query statistics, and a series of `EXPLAIN` results.

```
see it  →  find the suspicious part  →  see why  →  fix it  →  confirm the fix
```

Nothing needs to be installed on the database host. DBSCOPE can connect directly
or through SSH, so the database port does not need to be exposed publicly.

```
Browser → DBSCOPE → SSH tunnel (optional) → MySQL :3306 / PostgreSQL :5432
```

---

## Quick start

```bash
pnpm install
pnpm build
pnpm start          # http://127.0.0.1:5274
```

For development with hot reload:

```bash
pnpm dev            # UI on :5273, API on :5274
```

Then fill in the connect form:

| SSH (optional) | Database |
|---|---|
| host, port, user | MySQL or PostgreSQL |
| private key path or PEM text | host as seen from the SSH host, port, user, password, database |

Connection settings are remembered between sessions. Passwords, private keys,
and key passphrases are not.

Requires Node 22.18+ or 24.11+.

---

## What it shows

### Overview

The whole schema as one picture. **Node size is row count, node color is
measured load**, so the expensive tables are the big hot ones — visible before
you read a single number.

- Joins with no index on the FK column are drawn as broken red lines.
- Relations are **inferred from column naming** when foreign keys are not
  declared.
- Tables are ranked by a heat score combining size, measured query time, and
  rule violations.

### Queries

Ranked by **share of total server time**, not by how slow a single run feels. A
2 ms query run 50,000 times outranks a 900 ms query run twice — that ordering is
the entire point.

Reads from MySQL `performance_schema` or PostgreSQL `pg_stat_statements`. When
query statistics are unavailable, DBSCOPE explains why and falls back to schema
rules rather than showing an empty screen.

On PostgreSQL the counters can be reset for the connected database. MySQL has no
per-database reset — every available method clears the whole server — so
DBSCOPE does not offer one there.

### EXPLAIN

The plan is drawn as a pipeline, and **the connector between steps is as wide as
the number of rows flowing through it**. A query that reads 256,180 rows to
return 20 looks like a funnel before you read anything.

Flagged automatically: `type = ALL`, `key = NULL`, large row estimates,
`Using filesort`, `Using temporary`, and join buffers. The raw EXPLAIN table and
`EXPLAIN ANALYZE` (MySQL 8.0.18+) are both there when you want them.

### The improvement loop

From a plan, **Create and compare** runs the whole cycle in one click:

```
EXPLAIN → CREATE INDEX → re-EXPLAIN → Before / After verdict
```

The verdict states what changed in plain terms — *"1843× fewer rows, 256,180 →
139, and 3 issues disappeared"* — with both plans side by side.

---

## Try it with the local fixture

The Docker fixture provides SSH in front of deliberately under-indexed MySQL and
PostgreSQL databases on a private network. Their database ports are **not**
published to the host, so the SSH tunnel is genuinely exercised.

Both databases are seeded with the **same schema and the same rows** — 1M rows
across six tables, with the same indexes present and the same ones deliberately
missing. Anything the UI shows differently between them is therefore an engine
difference, not a fixture difference.

```bash
pnpm fixture:up                 # boots and seeds (a few minutes the first time)
bash fixture/workload.sh 3      # generates traffic so the Queries view has data
pnpm verify                     # MySQL assertions through a real SSH tunnel
pnpm verify:postgres            # the same for PostgreSQL
pnpm verify:parity              # asserts the two fixtures really are identical
pnpm verify:preview             # Data Viewer cells stay previews on both engines
```

One difference is expected and is not a bug: reported row counts are planner
estimates, so MySQL may show ~258,635 rows where PostgreSQL shows 262,144 for
the same table. InnoDB samples index pages; PostgreSQL reports what the last
`ANALYZE` recorded. DBSCOPE marks these figures approximate.

`fixture:up` prints the SSH port it chose, the key path, and the credentials.
Inside the fixture network the hosts are `mysql` and `postgres`.

To check the UI itself in a real browser:

```bash
node scripts/verify-ui.mjs      # screenshots land in shots/
```

Tear it down with `pnpm fixture:down`.

---

## Safety

The API binds to `127.0.0.1` and has **no login of its own**. Do not expose it to a network; to use it from another machine, reach it through an SSH port forward.

This tool can point at a live database, so its write surface is deliberately narrow:

- Only non-locking `SELECT` / read-only `WITH` statements can be explained. Stacked statements, writable CTEs, delay/lock functions, and file output are refused.
- `EXPLAIN ANALYZE` is opt-in and gets a 5-second execution limit because it actually runs the query. On PostgreSQL it runs inside a read-only transaction that is always rolled back; MySQL has no such isolation. Neither can stop side effects inside a user-defined function, so do not analyze statements that call functions you do not trust.
- Index creation and dropping are the only writes, and an index that enforces a data guarantee — `PRIMARY KEY`, `UNIQUE`, or one backing a foreign key — cannot be dropped on either engine. Destructive UI actions require confirmation.
- PostgreSQL index DDL uses `CONCURRENTLY`, so building an index does not block an existing workload.
- Data Viewer filters are structured: columns/operators are allowlisted and values are always bound parameters. Arbitrary WHERE SQL is never accepted.
- Passwords, SSH keys, and passphrases are kept in server memory only for the session, never in the browser or on disk. Idle sessions close after two hours. Key-file paths are limited to `~/.ssh`.
- SSH host keys are verified against `~/.ssh/known_hosts` (or `DBSCOPE_KNOWN_HOSTS`), and an unknown or changed key is refused. `@cert-authority`, `@revoked`, and wildcard entries are not interpreted, so such hosts read as unknown. Skipping the check is an explicit opt-in.
- The connection pool is capped at 4 connections, so DBSCOPE cannot itself become significant load.
- Row counts are planner estimates — an exact `COUNT(*)` on a large table is itself the kind of stall this tool exists to prevent. Anything approximate is labeled.

---

## Layout

```
server/database/    adapter contract; mysql/ and postgres/ hold each engine
server/core/        engine-independent: session, SSH tunnel, rules, advice
server/routes/      HTTP API
shared/types.ts     the contract between server and UI
src/views/          Connect, Overview, TableDetail, Queries, Explain
src/components/     HeatGraph (ER + load), PlanFlow (the pipeline view)
fixture/            Docker SSH + MySQL/PostgreSQL test environment (same data)
scripts/            verification against real databases
```

Adding another engine means implementing `DatabaseAdapter` in
`server/database/` and registering it; the API, rules, and UI are unchanged.

---

## Theming

Both themes are checked against WCAG in `src/lib/theme.test.ts`, which reads the
tokens out of the stylesheets so a color cannot drift past the limits unnoticed:

- Every text tone clears **4.5:1** (WCAG AA) on every surface.
- Borders that carry meaning use `--line-strong` and clear **3:1** (WCAG 1.4.11);
  purely decorative hairlines are exempt and stay quiet.
- The dark theme also has an **upper** bound. White on near-black measures 19:1
  and causes halation — the glow that makes text look like it is vibrating — so
  peak contrast is held near 14:1: well past the 7:1 AAA bar, without the glare.

Use the tokens rather than literal colors; a hardcoded hex will not follow the
theme and will not be covered by those tests.

---

Licensed under the [MIT License](LICENSE).
