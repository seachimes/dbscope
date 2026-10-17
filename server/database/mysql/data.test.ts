import { strict as assert } from "node:assert";
import { test } from "node:test";
import { previewColumn } from "./data.ts";

test("text and JSON columns are truncated in SQL", () => {
  assert.equal(previewColumn("body", "longtext"), "LEFT(`body`, 200) AS `body`");
  assert.equal(previewColumn("meta", "JSON"), "LEFT(`meta`, 200) AS `meta`");
});

test("binary columns are replaced by their size", () => {
  assert.equal(
    previewColumn("avatar", "longblob"),
    "CONCAT('<binary ', OCTET_LENGTH(`avatar`), ' B>') AS `avatar`",
  );
});

test("other columns are selected unchanged", () => {
  assert.equal(previewColumn("id", "bigint"), "`id`");
  assert.equal(previewColumn("created_at", "datetime"), "`created_at`");
});
