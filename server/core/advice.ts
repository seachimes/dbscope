import type { Issue, QueryAdvice } from "#shared/types.ts";

interface QueryShape {
  digestText: string;
  execCount: number;
  totalTimeMs: number;
  avgTimeMs: number;
  rowsExamined: number;
  rowsSent: number;
}

/**
 * Conservative, explainable query-shape advice. These rules never rewrite or
 * execute SQL: they tell the operator what pattern is likely expensive and
 * what to measure next. Advice that changes request/application behavior ranks
 * above adding another index.
 */
export function queryAdvice(q: QueryShape): QueryAdvice[] {
  const sql = q.digestText.trim();
  const advice: QueryAdvice[] = [];
  const add = (item: QueryAdvice) => advice.push(item);

  // A tiny point lookup repeated hundreds of times is more likely an N+1 call
  // site than a single bad plan. Keep the threshold conservative to avoid
  // labeling legitimate high-QPS endpoint traffic as N+1 too eagerly.
  const pointLookup = /\bWHERE\b[\s\S]*(?:=|\bIN\s*\()\s*\?/i.test(sql);
  const simpleSelect = /^SELECT\b/i.test(sql) && !/\b(?:GROUP\s+BY|UNION|HAVING)\b/i.test(sql);
  if (simpleSelect && pointLookup && q.execCount >= 100 && q.avgTimeMs <= 20) {
    add({
      kind: "batch",
      confidence: "medium",
      priority: 100,
      title: `Possible N+1: ${q.execCount.toLocaleString()} similar lookups`,
      detail:
        "This query is individually cheap but repeated often. Check whether one parent/list request triggers it once per row. Batch IDs with IN (...), join once, or preload into a map before adding an index.",
      example: "SELECT ... FROM child WHERE parent_id IN (?, ?, ...)",
    });
  }

  if (/^SELECT\s+(?:[\w`]+\.)?\*/i.test(sql)) {
    add({
      kind: "rewrite",
      confidence: "high",
      priority: 85,
      title: "Fetch only the columns the response uses",
      detail:
        "SELECT * transfers unnecessary TEXT/BLOB data and can prevent a covering-index plan. List required columns first; consider an index only after the narrower query is measured.",
      example: "SELECT id, user_id, created_at FROM ...",
    });
  }

  const offset = /\bLIMIT\s+(?:\?|\d+)\s*(?:,|OFFSET\s+)\s*(\d+|\?)/i.exec(sql);
  if (offset) {
    add({
      kind: "rewrite",
      confidence: offset[1] === "?" ? "medium" : "high",
      priority: 95,
      title: "Prefer keyset pagination over OFFSET",
      detail:
        "Large OFFSET values force MySQL to read and discard earlier rows on every page. Continue from the last stable sort key instead.",
      example: "WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
    });
  }

  if (/\bLIKE\s+['"]?%/i.test(sql) || /\bLIKE\s+CONCAT\s*\(\s*['"]%/i.test(sql)) {
    add({
      kind: "rewrite",
      confidence: "high",
      priority: 95,
      title: "A normal B-tree index cannot solve a leading-wildcard search",
      detail:
        "LIKE '%term%' cannot seek into a regular index. Consider FULLTEXT, a purpose-built search table, prefix search, or changing the product requirement.",
      example: "MATCH(title, body) AGAINST (? IN BOOLEAN MODE)",
    });
  }

  if (/\bWHERE\b[\s\S]*\b(?:DATE|YEAR|MONTH|LOWER|UPPER|CAST|COALESCE)\s*\(\s*[`\w.]+/i.test(sql)) {
    add({
      kind: "rewrite",
      confidence: "high",
      priority: 90,
      title: "Make the predicate sargable",
      detail:
        "Wrapping a column in a function usually prevents an ordinary index seek. Move the transformation to the constant side or use a range/generated column.",
      example: "created_at >= ? AND created_at < ?  -- instead of DATE(created_at) = ?",
    });
  }

  if (/\bWHERE\b[\s\S]*\(\s*SELECT\b/i.test(sql)) {
    add({
      kind: "rewrite",
      confidence: "medium",
      priority: 80,
      title: "Check for a correlated subquery",
      detail:
        "If the inner SELECT depends on each outer row, it may execute repeatedly. Compare a JOIN, EXISTS, or one pre-aggregated derived table with EXPLAIN ANALYZE.",
      example: "LEFT JOIN (SELECT parent_id, COUNT(*) ... GROUP BY parent_id) x USING (parent_id)",
    });
  }

  if (/\bDISTINCT\b/i.test(sql)) {
    add({
      kind: "measure",
      confidence: "medium",
      priority: 45,
      title: "Verify that DISTINCT is semantically necessary",
      detail:
        "DISTINCT can hide duplicate rows introduced by a join and requires deduplication. Fixing join cardinality is often cheaper than sorting/hash-deduplicating the result.",
    });
  }

  if (/\bORDER\s+BY\s+RAND\s*\(/i.test(sql)) {
    add({
      kind: "rewrite",
      confidence: "high",
      priority: 100,
      title: "Avoid ORDER BY RAND() on growing tables",
      detail:
        "MySQL assigns and sorts a random value for every candidate row. Sample an ID/range, maintain a random key, or select candidates in two phases.",
    });
  }

  if (q.totalTimeMs >= 1000 && q.execCount >= 100 && advice.length === 0) {
    add({
      kind: "measure",
      confidence: "low",
      priority: 20,
      title: "Inspect the call site as well as the plan",
      detail:
        "High cumulative time can come from request fan-out, polling, or missing caching even when one execution is reasonable. Correlate this digest with an endpoint before changing schema.",
    });
  }

  return advice.toSorted((a, b) => b.priority - a.priority);
}

export function adviceIssues(advice: QueryAdvice[]): Issue[] {
  return advice.slice(0, 3).map((a) => ({
    code:
      a.kind === "batch"
        ? "N_PLUS_ONE"
        : /OFFSET/.test(a.title)
          ? "LARGE_OFFSET"
          : /wildcard/.test(a.title)
            ? "LEADING_WILDCARD"
            : /sargable/.test(a.title)
              ? "NON_SARGABLE"
              : /subquery/.test(a.title)
                ? "CORRELATED_SUBQUERY"
                : "SELECT_STAR",
    severity: a.priority >= 95 ? "critical" : a.priority >= 70 ? "warning" : "info",
    title: a.title,
    detail: a.detail,
  }));
}
