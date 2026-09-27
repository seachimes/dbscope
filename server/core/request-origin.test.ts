import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkLocalRequest } from "./request-origin.ts";

test("accepts loopback access, including a remapped SSH forward port", () => {
  for (const host of ["127.0.0.1:5274", "localhost:9999", "[::1]:5274"]) {
    assert.doesNotThrow(() => checkLocalRequest(host, `http://${host}`));
    assert.doesNotThrow(() => checkLocalRequest(host, undefined));
  }
});

test("rejects DNS rebinding and cross-origin browser requests", () => {
  for (const host of [
    undefined,
    "evil.example:5274",
    "localhost.evil.example:5274",
    "localhost:0",
    "localhost:65536",
    "localhost:5274@evil.example",
  ]) {
    assert.throws(() => checkLocalRequest(host, undefined), /loopback host/);
  }
  for (const origin of [
    "http://evil.example",
    "http://localhost:1234",
    "https://localhost:5274",
    "null",
    "http://localhost:5274.evil.example",
  ]) {
    assert.throws(() => checkLocalRequest("localhost:5274", origin), /Origin/);
  }
});

test("Vite origin is permitted only when explicitly configured", () => {
  assert.doesNotThrow(() => checkLocalRequest("127.0.0.1:5274", undefined));
  assert.throws(() => checkLocalRequest("127.0.0.1:5274", "http://127.0.0.1:5273"), /Origin/);
  assert.doesNotThrow(() =>
    checkLocalRequest("127.0.0.1:5274", "http://127.0.0.1:5273", "http://127.0.0.1:5273"),
  );
});
