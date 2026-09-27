import { strict as assert } from "node:assert";
import { test } from "node:test";
import { qualify, quoteIdent, toNumber, toStringArray } from "./sql.ts";

test("quotes identifiers and escapes embedded double quotes", () => {
  assert.equal(quoteIdent("posts"), '"posts"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
  assert.equal(qualify("public", "posts"), '"public"."posts"');
});

test("rejects identifiers that cannot be safely quoted", () => {
  assert.throws(() => quoteIdent(""));
  assert.throws(() => quoteIdent("a\0b"));
  assert.throws(() => quoteIdent("x".repeat(64)));
});

test("parses an unparsed name[] literal into real columns", () => {
  // node-postgres has no parser for name[] (OID 1003), so the driver can hand
  // back the raw literal. This is the exact shape that used to crash the
  // Indexes tab with "columns.join is not a function".
  assert.deepEqual(toStringArray("{id}"), ["id"]);
  assert.deepEqual(toStringArray("{user_id,created_at}"), ["user_id", "created_at"]);
});

test("keeps quoted array elements containing commas intact", () => {
  assert.deepEqual(toStringArray('{"lower((email)::text)",id}'), ["lower((email)::text)", "id"]);
});

test("passes real arrays through and tolerates empty input", () => {
  assert.deepEqual(toStringArray(["id", "user_id"]), ["id", "user_id"]);
  assert.deepEqual(toStringArray("{}"), []);
  assert.deepEqual(toStringArray(null), []);
});

test("converts bigint strings without losing the value", () => {
  assert.equal(toNumber("262144"), 262144);
  assert.equal(toNumber(null, 7), 7);
  assert.equal(toNumber("not-a-number", 3), 3);
});
