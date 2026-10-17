import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool } from "pg";
import { dropIndex, indexName, previewColumn } from "./data.ts";

test("uses the requested name when it fits", () => {
  assert.equal(
    indexName({ table: "posts", columns: ["user_id"], name: "idx_custom" }),
    "idx_custom",
  );
});

test("derives a readable name from the table and columns", () => {
  assert.equal(
    indexName({ table: "posts", columns: ["user_id", "created_at"] }),
    "idx_posts_user_id_created_at",
  );
});

test("truncates to the 63-byte identifier limit", () => {
  const name = indexName({ table: "posts", columns: ["x".repeat(200)] });
  assert.ok(Buffer.byteLength(name) <= 63, `${Buffer.byteLength(name)} bytes`);
});

test("two names sharing a long prefix do not collide after truncation", () => {
  // The regression this guards: hashing only the surviving prefix produced the
  // same suffix for both, so the second CREATE INDEX failed as a duplicate.
  const prefix = "a".repeat(70);
  const first = indexName({ table: prefix, columns: ["colX"] });
  const second = indexName({ table: prefix, columns: ["colY"] });
  assert.notEqual(first, second);
});

test("truncation is deterministic", () => {
  const request = { table: "posts", columns: ["y".repeat(120)] };
  assert.equal(indexName(request), indexName(request));
});

test("dropIndex refuses primary, constraint-backed, and standalone UNIQUE indexes", async () => {
  for (const [label, row] of [
    ["PRIMARY KEY", { is_primary: true, is_unique: true, constraint_name: "table_pkey" }],
    [
      "constraint-backed UNIQUE",
      { is_primary: false, is_unique: true, constraint_name: "table_key" },
    ],
    ["standalone UNIQUE", { is_primary: false, is_unique: true, constraint_name: null }],
  ] as const) {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [row] };
      },
    } as unknown as Pool;
    await assert.rejects(
      dropIndex(pool, "public", "table", "table_key"),
      /refusing|backs constraint/,
    );
    assert.equal(queries.length, 1, `${label} must never reach DROP INDEX`);
    assert.match(queries[0]!, /indisunique/);
  }
});

test("dropIndex still allows an ordinary index", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [{ is_primary: false, is_unique: false, constraint_name: null }] };
    },
  } as unknown as Pool;
  const result = await dropIndex(pool, "public", "table", "table_idx");
  assert.equal(result.ok, true);
  assert.equal(queries[1], 'DROP INDEX CONCURRENTLY "public"."table_idx"');
});

test("previewColumn truncates text and JSON and sizes binary values", () => {
  const column = (name: string, typeName: string, category: string) => ({
    name,
    typeSchema: "pg_catalog",
    typeName,
    category,
  });
  assert.equal(previewColumn(column("body", "text", "S")), 'left("body", 200) AS "body"');
  assert.equal(previewColumn(column("meta", "jsonb", "U")), 'left("meta"::text, 200) AS "meta"');
  assert.equal(
    previewColumn(column("avatar", "bytea", "U")),
    `'<binary ' || octet_length("avatar") || ' B>' AS "avatar"`,
  );
  assert.equal(previewColumn(column("id", "int8", "N")), '"id"');
});
