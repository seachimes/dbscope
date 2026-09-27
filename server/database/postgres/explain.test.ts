import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPlanSteps, planIssues, suggestIndexes } from "./explain.ts";

test("counts rows discarded by a filter as rows read", () => {
  // PostgreSQL reports rows *emitted*, so this scan says 25 while actually
  // reading 50,000. The discarded rows are the work an index would remove.
  const [step] = buildPlanSteps({
    "Node Type": "Seq Scan",
    "Relation Name": "posts",
    "Actual Rows": 25,
    "Rows Removed by Filter": 49_975,
    Filter: "(user_id = 42)",
  });
  assert.equal(step?.rows, 50_000);
  assert.equal(step?.severity, "critical");
});

test("uses the relation size when a filtered scan was not executed", () => {
  // Without ANALYZE there is no "Rows Removed by Filter", so a filtered scan
  // would otherwise look as cheap as its output.
  const [step] = buildPlanSteps(
    {
      "Node Type": "Seq Scan",
      "Relation Name": "posts",
      "Plan Rows": 25,
      Filter: "(user_id = 42)",
    },
    new Map([["posts", 50_000]]),
  );
  assert.equal(step?.rows, 50_000);
  assert.equal(step?.severity, "critical");
});

test("does not treat a small sequential scan as critical", () => {
  const [step] = buildPlanSteps({
    "Node Type": "Seq Scan",
    "Relation Name": "categories",
    "Plan Rows": 12,
  });
  assert.equal(step?.severity, "warning");
  assert.equal(
    planIssues(
      buildPlanSteps({
        "Node Type": "Seq Scan",
        "Relation Name": "categories",
        "Plan Rows": 12,
      }),
    )[0]?.severity,
    "warning",
  );
});

test("an index scan is not a bottleneck", () => {
  const steps = buildPlanSteps({
    "Node Type": "Index Scan",
    "Relation Name": "posts",
    "Index Name": "idx_posts_user_id",
    "Plan Rows": 20,
  });
  assert.equal(steps[0]?.kind, "ref");
  assert.equal(steps[0]?.severity, "none");
  assert.equal(steps[0]?.sublabel, "index: idx_posts_user_id");
  assert.equal(planIssues(steps).length, 0);
});

test("a sort that spilled to disk is critical, an in-memory sort is not", () => {
  const onDisk = buildPlanSteps({
    "Node Type": "Sort",
    "Sort Space Type": "Disk",
    "Plan Rows": 500,
  });
  assert.equal(onDisk[0]?.severity, "critical");
  assert.equal(planIssues(onDisk)[0]?.code, "FILESORT");

  const inMemory = buildPlanSteps({
    "Node Type": "Sort",
    "Sort Space Type": "Memory",
    "Plan Rows": 500,
  });
  assert.equal(inMemory[0]?.severity, "none");
  assert.equal(planIssues(inMemory).length, 0);
});

test("multiplies a nested loop inner side by its loop count", () => {
  const [inner] = buildPlanSteps({
    "Node Type": "Seq Scan",
    "Relation Name": "comments",
    "Actual Rows": 500,
    "Actual Loops": 1000,
  });
  assert.equal(inner?.rows, 500_000);
  assert.equal(inner?.severity, "critical");
});

test("flattens children before parents so steps read in execution order", () => {
  const steps = buildPlanSteps({
    "Node Type": "Limit",
    Plans: [
      { "Node Type": "Sort", Plans: [{ "Node Type": "Seq Scan", "Relation Name": "posts" }] },
    ],
  });
  assert.deepEqual(
    steps.map((s) => s.label),
    ["SEQ SCAN", "SORT", "LIMIT"],
  );
});

test("an empty plan produces no steps instead of throwing", () => {
  assert.deepEqual(buildPlanSteps(undefined), []);
});

test("suggests equality columns before the sort column", () => {
  const sql = "SELECT id FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20";
  const steps = buildPlanSteps(
    {
      "Node Type": "Seq Scan",
      "Relation Name": "posts",
      "Plan Rows": 25,
      Filter: "(user_id = 42)",
    },
    new Map([["posts", 50_000]]),
  );
  const [suggestion] = suggestIndexes(
    sql,
    [...steps, { ...steps[0]!, kind: "filesort", table: undefined }],
    new Map(),
  );

  assert.deepEqual(suggestion?.columns, ["user_id", "created_at"]);
  assert.ok(suggestion?.ddl.includes("CONCURRENTLY"), suggestion?.ddl);
  assert.equal(suggestion?.confidence, "high");
});

test("marks a suggestion redundant when an index already covers the prefix", () => {
  const sql = "SELECT id FROM posts WHERE user_id = 42";
  const steps = buildPlanSteps(
    {
      "Node Type": "Seq Scan",
      "Relation Name": "posts",
      "Plan Rows": 25,
      Filter: "(user_id = 42)",
    },
    new Map([["posts", 50_000]]),
  );
  const existing = new Map([
    [
      "posts",
      [
        {
          name: "idx_posts_user_id",
          unique: false,
          type: "BTREE",
          columns: ["user_id"],
          cardinality: null,
          isPrimary: false,
        },
      ],
    ],
  ]);

  assert.equal(suggestIndexes(sql, steps, existing)[0]?.redundant, true);
});

test("suggests nothing when the plan already uses an index", () => {
  const steps = buildPlanSteps({
    "Node Type": "Index Scan",
    "Relation Name": "posts",
    "Index Name": "idx",
    "Plan Rows": 20,
  });
  assert.deepEqual(suggestIndexes("SELECT id FROM posts WHERE user_id = 42", steps, new Map()), []);
});
