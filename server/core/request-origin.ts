import { HttpError } from "./session.ts";

/**
 * Host (`host[:port]`) of a configured public origin such as
 * `https://dbscope.example.com`. Undefined when unset, or when the value is not
 * a bare origin — a rejected value only ever narrows what is served.
 */
export function publicHostOf(publicOrigin: string | undefined): string | undefined {
  if (publicOrigin === undefined) return undefined;
  try {
    const url = new URL(publicOrigin);
    return url.origin === publicOrigin ? url.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Only loopback hosts are served, including access through SSH -L forwarding.
 * Set DBSCOPE_PUBLIC_ORIGIN to additionally serve a public URL through a tunnel
 * or reverse proxy.
 *
 * The public origin is an exact allowlist pair: that Host *and* that Origin, so
 * it does not weaken the CSRF / DNS rebinding check for anything else. Values
 * that are not a bare origin (missing scheme, trailing slash, "null") are
 * ignored, which leaves the server loopback-only rather than guessing.
 */
export function checkLocalRequest(
  host: string | undefined,
  origin: string | undefined,
  devOrigin?: string,
  publicOrigin?: string,
): void {
  const hostLower = host?.toLowerCase();

  // Do not tie the Host port to the server port: `ssh -L 9999:localhost:5274`
  // legitimately sends Host: localhost:9999 to the server on port 5274.
  const match = hostLower?.match(/^(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/);
  const isLoopback =
    match !== undefined && match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 65_535;
  const publicHost = publicHostOf(publicOrigin);
  const isPublicHost = publicHost !== undefined && hostLower === publicHost;

  if (!isLoopback && !isPublicHost) {
    throw new HttpError(403, "use a loopback host (localhost or 127.0.0.1)");
  }
  if (origin === undefined) return; // CLI requests do not send an Origin header.
  try {
    const url = new URL(origin);
    if (url.origin !== origin) throw new Error("Origin is not a bare origin");
    // SSH -L: the browser sees loopback, so the Origin matches the Host.
    if (isLoopback && url.protocol === "http:" && url.host.toLowerCase() === hostLower) return;
    // Public URL: the configured origin, and only on the configured Host.
    if (isPublicHost && origin === publicOrigin) return;
    // Vite dev server: a loopback page served from another port.
    if (url.protocol === "http:" && origin === devOrigin) return;
  } catch {
    /* Invalid Origin fails closed. */
  }
  throw new HttpError(403, "request Origin does not match the DBSCOPE address");
}
