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

test("a configured public origin is served through a tunnel", () => {
  const publicOrigin = "https://dbscope.example.com";

  // The tunnel forwards the public Host, and may forward the service host.
  assert.doesNotThrow(() =>
    checkLocalRequest("dbscope.example.com", undefined, undefined, publicOrigin),
  );
  assert.doesNotThrow(() =>
    checkLocalRequest("127.0.0.1:5274", undefined, undefined, publicOrigin),
  );

  // Browser POSTs carry the public Origin; every other site is still rejected.
  assert.doesNotThrow(() =>
    checkLocalRequest("dbscope.example.com", publicOrigin, undefined, publicOrigin),
  );
  for (const origin of [
    "https://evil.example",
    "https://dbscope.example.com.evil.example",
    "http://dbscope.example.com",
    "null",
  ]) {
    assert.throws(
      () => checkLocalRequest("dbscope.example.com", origin, undefined, publicOrigin),
      /Origin/,
    );
  }

  // A lookalike Host is not the public host, and enabling the public URL does
  // not let a public Origin ride along on a loopback request.
  assert.throws(
    () => checkLocalRequest("dbscope.example.com.evil.example", undefined, undefined, publicOrigin),
    /loopback host/,
  );
  assert.throws(
    () => checkLocalRequest("127.0.0.1:5274", publicOrigin, undefined, publicOrigin),
    /Origin/,
  );

  // ssh -L keeps working while the public URL is enabled.
  assert.doesNotThrow(() =>
    checkLocalRequest("localhost:9999", "http://localhost:9999", undefined, publicOrigin),
  );
});

test("a public origin that is not a bare origin opens nothing", () => {
  for (const bad of ["dbscope.example.com", "https://", "https://dbscope.example.com/", "null"]) {
    assert.throws(
      () => checkLocalRequest("dbscope.example.com", undefined, undefined, bad),
      /loopback host/,
    );
  }
});
