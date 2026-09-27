import { HttpError } from "./session.ts";

/** Only loopback hosts are served, including access through SSH -L forwarding. */
export function checkLocalRequest(
  host: string | undefined,
  origin: string | undefined,
  devOrigin?: string,
): void {
  // Do not tie the Host port to the server port: `ssh -L 9999:localhost:5274`
  // legitimately sends Host: localhost:9999 to the server on port 5274.
  const match = host?.toLowerCase().match(/^(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65_535) {
    throw new HttpError(403, "use a loopback host (localhost or 127.0.0.1)");
  }
  if (origin === undefined) return; // CLI requests do not send an Origin header.
  try {
    const url = new URL(origin);
    if (
      url.protocol === "http:" &&
      url.origin === origin &&
      (url.host.toLowerCase() === host?.toLowerCase() ||
        (devOrigin !== undefined && origin === devOrigin))
    )
      return;
  } catch {
    /* Invalid Origin fails closed. */
  }
  throw new HttpError(403, "request Origin does not match the DBSCOPE address");
}
