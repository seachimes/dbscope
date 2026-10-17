import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createIndexDdl, dropIndexDdl, previewColumn } from "./data.ts";

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

test("index DDL comes as the ALTER TABLE run here and a CREATE INDEX for SQL files", () => {
  assert.deepEqual(createIndexDdl({ table: "posts", columns: ["user_id", "created_at"] }), {
    ddl: "ALTER TABLE `posts` ADD INDEX `idx_user_id_created_at` (`user_id`, `created_at`);",
    fileDdl: "CREATE INDEX `idx_user_id_created_at` ON `posts` (`user_id`, `created_at`);",
  });
  assert.equal(
    createIndexDdl({ table: "users", columns: ["email"], name: "uq_email", unique: true }).fileDdl,
    "CREATE UNIQUE INDEX `uq_email` ON `users` (`email`);",
  );
  assert.deepEqual(dropIndexDdl("posts", "idx_user_id"), {
    ddl: "ALTER TABLE `posts` DROP INDEX `idx_user_id`;",
    fileDdl: "DROP INDEX `idx_user_id` ON `posts`;",
  });
});
