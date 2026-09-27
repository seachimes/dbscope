import assert from "node:assert/strict";
import test from "node:test";
import { queryAdvice } from "./advice.ts";

const q = (digestText: string, overrides = {}) => ({
  digestText,
  execCount: 1,
  totalTimeMs: 10,
  avgTimeMs: 10,
  rowsExamined: 1,
  rowsSent: 1,
  ...overrides,
});

test("detects a likely N+1 point lookup without claiming certainty", () => {
  const advice = queryAdvice(
    q("SELECT `name` FROM `users` WHERE `id` = ?", {
      execCount: 1200,
      totalTimeMs: 1800,
      avgTimeMs: 1.5,
    }),
  );
  assert.equal(advice[0]?.kind, "batch");
  assert.equal(advice[0]?.confidence, "medium");
});

test("does not flag a low-count lookup as N+1", () => {
  const advice = queryAdvice(q("SELECT `name` FROM `users` WHERE `id` = ?", { execCount: 10 }));
  assert.equal(
    advice.some((a) => a.kind === "batch"),
    false,
  );
});

test("prioritizes keyset pagination for OFFSET queries", () => {
  const advice = queryAdvice(q("SELECT `id` FROM `posts` ORDER BY `id` LIMIT ? OFFSET ?"));
  assert.match(advice[0]?.title ?? "", /keyset/i);
});

test("does not recommend a normal index for leading wildcard search", () => {
  const advice = queryAdvice(q("SELECT `id` FROM `posts` WHERE `body` LIKE '%foo%'"));
  assert.match(advice[0]?.title ?? "", /B-tree/i);
});

test("detects non-sargable function predicates", () => {
  const advice = queryAdvice(q("SELECT `id` FROM `posts` WHERE DATE(`created_at`) = ?"));
  assert.match(advice[0]?.title ?? "", /sargable/i);
});

test("detects SELECT star and offers a narrower projection", () => {
  const advice = queryAdvice(q("SELECT * FROM `posts` WHERE `id` = ?"));
  assert.ok(advice.some((a) => /columns/.test(a.title)));
});
