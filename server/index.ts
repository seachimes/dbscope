import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes/api.ts";
import { HttpError, shutdownAll } from "./core/session.ts";
import { checkLocalRequest } from "./core/request-origin.ts";
import type { ApiError } from "#shared/types.ts";

const app = new Hono();
const port = Number(process.env.PORT ?? 5274);

// Reject DNS rebinding and cross-origin browser requests before either API or
// static assets are served. SSH -L still works: the browser sees localhost.
app.use("*", async (c, next) => {
  checkLocalRequest(c.req.header("host"), c.req.header("origin"), process.env.DBSCOPE_DEV_ORIGIN);
  await next();
});

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  // mysql2 attaches a `code` like ER_DUP_KEYNAME; surfacing it verbatim is far
  // more useful during diagnosis than a generic message.
  const code = (err as { code?: string }).code;
  const body: ApiError = {
    error: err.message,
    ...(err instanceof HttpError && err.detail ? { detail: err.detail } : {}),
    ...(code ? { code } : {}),
  };
  if (status >= 500) console.error("[api]", err);
  return c.json(body, status as 400);
});

app.route("/api", api);
app.get("/api/health", (c) => c.json({ ok: true }));

// Serve the built UI when it exists, so `pnpm build && pnpm start` is a
// single-process deployment. In development Vite serves the front end.
//
// The files are resolved from this module rather than the working directory:
// serveStatic's root is cwd-relative, which silently 404s whenever the server
// is started from anywhere but the project root.
const distDir = fileURLToPath(new URL("../dist", import.meta.url));

if (existsSync(join(distDir, "index.html"))) {
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };

  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();

    // Normalize away any `..` so a request cannot escape dist/.
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(distDir, rel);
    const file =
      candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(distDir, "index.html"); // SPA fallback

    const type = TYPES[extname(file)] ?? "application/octet-stream";
    // Hashed asset names make long-lived caching safe; index.html must not be.
    const cache = file.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    return c.body(await readFile(file), 200, {
      "content-type": type,
      "cache-control": cache,
    });
  });
}

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (addr) => {
  console.log(`DBSCOPE api listening on http://127.0.0.1:${addr.port}`);
});

// SSH tunnels and MySQL pools must be closed, or ssh processes linger.
const shutdown = async () => {
  await shutdownAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
