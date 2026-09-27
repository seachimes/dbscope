import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveKey } from "./tunnel.ts";

test("accepts inline SSH keys without persisting them", () => {
  assert.equal(
    resolveKey("-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----").toString(),
    "-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----\n",
  );
});

test("rejects arbitrary server files as SSH keys", () => {
  assert.throws(() => resolveKey("/etc/passwd"), /under ~\/\.ssh/);
  assert.throws(() => resolveKey("relative/key"), /absolute or start/);
});
