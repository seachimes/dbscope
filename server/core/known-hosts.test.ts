import { strict as assert } from "node:assert";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { hostPatterns, verifyHostKey } from "./known-hosts.ts";

const KEY = Buffer.from("a-host-key-body");
const KEY_B64 = KEY.toString("base64");
const TYPE = "ssh-ed25519";

test("writes port 22 without brackets and other ports with them", () => {
  assert.deepEqual(hostPatterns("db.example.com", 22), ["db.example.com", "[db.example.com]:22"]);
  assert.deepEqual(hostPatterns("db.example.com", 2222), ["[db.example.com]:2222"]);
});

test("accepts a key already trusted for the host", () => {
  const file = `db.example.com ${TYPE} ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "match" });
});

test("reports an unrelated host as unknown rather than trusted", () => {
  const file = `other.example.com ${TYPE} ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "unknown" });
});

test("reports a changed key for a known host as a mismatch", () => {
  // This is the case that must never be silently accepted: the host is known,
  // but it is presenting a different key.
  const file = `db.example.com ${TYPE} ${Buffer.from("a-different-key").toString("base64")}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "mismatch" });
});

test("matches a non-default port only via its bracketed form", () => {
  const file = `[db.example.com]:2222 ${TYPE} ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 2222, TYPE, KEY), { status: "match" });
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "unknown" });
});

test("matches a host listed among comma-separated aliases", () => {
  const file = `db.example.com,10.0.0.5 ${TYPE} ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "10.0.0.5", 22, TYPE, KEY), { status: "match" });
});

test("matches a hashed known_hosts entry", () => {
  const salt = randomBytes(20);
  const digest = createHmac("sha1", salt).update("db.example.com").digest();
  const file = `|1|${salt.toString("base64")}|${digest.toString("base64")} ${TYPE} ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "match" });
});

test("ignores comments, blank lines, and unsupported markers", () => {
  const file = [
    "# a comment",
    "",
    `@cert-authority db.example.com ${TYPE} ${KEY_B64}`,
    `db.example.com ${TYPE} ${KEY_B64}`,
  ].join("\n");
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "match" });
});

test("treats a key of a different type as not matching", () => {
  const file = `db.example.com ssh-rsa ${KEY_B64}\n`;
  assert.deepEqual(verifyHostKey(file, "db.example.com", 22, TYPE, KEY), { status: "mismatch" });
});
