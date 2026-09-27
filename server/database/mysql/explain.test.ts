import assert from "node:assert/strict";
import test from "node:test";
import type { ExplainRow } from "#shared/types.ts";
import { buildPlanStepsForTest } from "./explain.ts";

const row = (overrides: Partial<ExplainRow>): ExplainRow => ({
  id: 1,
  selectType: "SIMPLE",
  table: "posts",
  partitions: null,
  type: "index",
  possibleKeys: null,
  key: "PRIMARY",
  keyLen: "4",
  ref: null,
  rows: 20,
  filtered: 100,
  extra: "Backward index scan; Using index",
  ...overrides,
});

test("small type=index plan is an efficient ordered traversal, not a warning", () => {
  const step = buildPlanStepsForTest([row({})])[0]!;
  assert.equal(step.label, "INDEX-ORDER SCAN");
  assert.equal(step.severity, "none");
  assert.match(step.notes.join(" "), /LIMIT/);
  assert.equal(step.sublabel, "key: PRIMARY");
});

test("large type=index traversal remains a warning", () => {
  const step = buildPlanStepsForTest([row({ rows: 250_000 })])[0]!;
  assert.equal(step.severity, "warning");
  assert.match(step.notes.join(" "), /not a keyed lookup/);
});
