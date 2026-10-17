import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import type { ConnectRequest } from "#shared/types.ts";

const closed: unknown[] = [];
let nextPool = 0;

mock.module("../database/registry.ts", {
  namedExports: {
    getAdapter: () => ({
      engine: "postgres",
      defaultPort: 5432,
      createPool: () => ({ pool: nextPool++ }),
      probe: async () => ({
        version: "16.0",
        majorVersion: 16,
        supportsExplainAnalyze: true,
        queryStats: { enabled: false, digestEnabled: false },
      }),
      close: async (pool: unknown) => void closed.push(pool),
    }),
  },
});

const { createSession, getSession, shutdownAll } = await import("./session.ts");

const request: ConnectRequest = {
  engine: "postgres",
  ssh: null,
  mysql: { host: "db", port: 5432, user: "u", password: "p", database: "d" },
};

test("reconnecting past the limit closes the least recently used session", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push((await createSession(request)).id);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  getSession(ids[0]);

  await createSession(request);

  assert.throws(() => getSession(ids[1]), /session not found/);
  assert.deepEqual(closed, [{ pool: 1 }]);
  for (const id of [ids[0], ...ids.slice(2)]) assert.doesNotThrow(() => getSession(id));

  await shutdownAll();
});
