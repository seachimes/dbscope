import { randomUUID } from "node:crypto";
import { openTunnel, type Tunnel } from "./tunnel.ts";
import type { ConnectRequest, SessionInfo } from "#shared/types.ts";
import type { DatabaseAdapter, DatabasePool } from "../database/adapter.ts";
import { getAdapter } from "../database/registry.ts";

export interface Session {
  id: string;
  pool: DatabasePool;
  adapter: DatabaseAdapter;
  tunnel: Tunnel | null;
  info: SessionInfo;
  request: ConnectRequest;
  lastUsed: number;
}

const sessions = new Map<string, Session>();
const IDLE_MS = 2 * 60 * 60 * 1000;

export async function createSession(req: ConnectRequest): Promise<SessionInfo> {
  const adapter = getAdapter(req.engine);
  let tunnel: Tunnel | null = null;
  const port = req.mysql.port || adapter.defaultPort;
  if (req.ssh) tunnel = await openTunnel(req.ssh, req.mysql.host, port);
  const pool = adapter.createPool(req, {
    host: tunnel ? tunnel.host : req.mysql.host,
    port: tunnel ? tunnel.port : port,
  });

  try {
    const probe = await adapter.probe(pool);
    const id = randomUUID();
    const info: SessionInfo = {
      id,
      engine: adapter.engine,
      database: req.mysql.database,
      viaSsh: Boolean(req.ssh),
      mysqlVersion: probe.version,
      majorVersion: probe.majorVersion,
      supportsExplainAnalyze: probe.supportsExplainAnalyze,
      performanceSchema: probe.queryStats,
      connectedAt: new Date().toISOString(),
    };
    sessions.set(id, { id, pool, adapter, tunnel, info, request: req, lastUsed: Date.now() });
    return info;
  } catch (err) {
    await adapter.close(pool).catch(() => {});
    await tunnel?.close().catch(() => {});
    throw err;
  }
}

export function getSession(id: string | undefined): Session {
  if (!id) throw new HttpError(401, "missing session id");
  const session = sessions.get(id);
  if (!session) throw new HttpError(401, "session not found or expired; reconnect");
  session.lastUsed = Date.now();
  return session;
}

export async function closeSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  await session.adapter.close(session.pool).catch(() => {});
  await session.tunnel?.close().catch(() => {});
}
export function currentSession(id: string | undefined): SessionInfo {
  return getSession(id).info;
}

/**
 * An error carrying the HTTP status to return.
 *
 * Fields are assigned explicitly rather than declared as parameter properties,
 * which Node's type stripping does not support; the server must be runnable
 * without a TypeScript-aware loader.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string | undefined;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

// Idle sessions hold an SSH connection and a pool open; reap them periodically.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > IDLE_MS) void closeSession(id);
  }
}, 60_000);
reaper.unref();

export async function shutdownAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeSession));
}
