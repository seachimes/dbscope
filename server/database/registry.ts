import type { DatabaseEngine } from "#shared/types.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { mysqlAdapter } from "./mysql/adapter.ts";
import { postgresAdapter } from "./postgres/adapter.ts";

const adapters: Record<DatabaseEngine, DatabaseAdapter> = {
  mysql: mysqlAdapter,
  postgres: postgresAdapter,
};

export function getAdapter(engine: DatabaseEngine | undefined): DatabaseAdapter {
  return adapters[engine ?? "mysql"];
}
