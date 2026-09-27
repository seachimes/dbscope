import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateConnect } from "./api.ts";
import { HttpError } from "../core/session.ts";
import type { ConnectRequest } from "#shared/types.ts";

const valid: ConnectRequest = {
  engine: "postgres",
  ssh: null,
  mysql: { host: "127.0.0.1", port: 5432, user: "appuser", database: "appdb", password: "" },
};

test("PostgreSQL empty password is rejected before SCRAM or a tunnel", () => {
  assert.throws(
    () => validateConnect(valid),
    (error) =>
      error instanceof HttpError &&
      error.status === 400 &&
      /PostgreSQL database password is required/.test(error.message),
  );
});

test("a non-string DB password is rejected for both engines", () => {
  for (const engine of ["mysql", "postgres"] as const) {
    assert.throws(
      () =>
        validateConnect({
          ...valid,
          engine,
          mysql: { ...valid.mysql, password: null as unknown as string },
        }),
      (error) =>
        error instanceof HttpError &&
        error.status === 400 &&
        /database password must be a string/.test(error.message),
    );
  }
});

test("MySQL still accepts empty passwords; PostgreSQL accepts a nonempty password", () => {
  assert.doesNotThrow(() => validateConnect({ ...valid, engine: "mysql" }));
  assert.doesNotThrow(() =>
    validateConnect({ ...valid, mysql: { ...valid.mysql, password: "apppass" } }),
  );
});
