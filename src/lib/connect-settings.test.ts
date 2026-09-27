import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConnectionSettings, saveConnectionSettings } from "./connect-settings.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("saved settings never contain password, SSH key or passphrase", () => {
  const store = storage();
  saveConnectionSettings(store, {
    sshKey: "BEGIN PRIVATE KEY",
    dbPass: "secret",
    passphrase: "phrase",
    sshPassphrase: "encrypted-key-secret",
    dbHost: "db",
  });
  assert.deepEqual(JSON.parse(store.getItem("dbscope.connect.form")!), { dbHost: "db" });
});

test("old saved keys are removed on read, including the legacy storage key", () => {
  const store = storage();
  store.setItem(
    "sonde.connect.form",
    JSON.stringify({ sshKey: "BEGIN PRIVATE KEY", dbPass: "secret", sshHost: "vm" }),
  );
  assert.deepEqual(loadConnectionSettings(store), { sshHost: "vm" });
  assert.equal(store.getItem("sonde.connect.form"), null);
  assert.deepEqual(JSON.parse(store.getItem("dbscope.connect.form")!), { sshHost: "vm" });
});

test("invalid saved settings are discarded", () => {
  const store = storage();
  store.setItem("dbscope.connect.form", "not json");
  assert.deepEqual(loadConnectionSettings(store), {});
  assert.equal(store.getItem("dbscope.connect.form"), null);
});
