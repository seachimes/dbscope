import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal OpenSSH known_hosts lookup.
 *
 * Only what host-key verification needs: find the entries that apply to a
 * host:port and report whether a presented key matches one of them. Certificate
 * authorities, revoked keys, and @cert-authority markers are not interpreted;
 * a file using them will simply not produce a match, which fails closed.
 */

export type HostKeyVerdict =
  | { status: "match" }
  | { status: "unknown" }
  /** The host is known but presented a different key: a real warning sign. */
  | { status: "mismatch" };

/** OpenSSH omits the port for 22 and writes `[host]:port` otherwise. */
export function hostPatterns(host: string, port: number): string[] {
  return port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
}

function matchesHashedHost(token: string, host: string): boolean {
  // |1|<base64 salt>|<base64 hmac-sha1 of the hostname>
  const parts = token.split("|");
  if (parts.length !== 4 || parts[1] !== "1") return false;
  try {
    const salt = Buffer.from(parts[2]!, "base64");
    const expected = Buffer.from(parts[3]!, "base64");
    const actual = createHmac("sha1", salt).update(host).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hostMatches(field: string, host: string, port: number): boolean {
  if (field.startsWith("|1|")) {
    // Hashed entries cover one name each; try every spelling of this endpoint.
    return hostPatterns(host, port).some((pattern) => matchesHashedHost(field, pattern));
  }
  const patterns = hostPatterns(host, port);
  return field.split(",").some((entry) => patterns.includes(entry.trim()));
}

/**
 * Compare a presented host key against the known_hosts contents.
 *
 * `presentedKey` is the base64 body of the key as it appears in known_hosts,
 * which is exactly what ssh2 hands us as a DER/OpenSSH key buffer.
 */
export function verifyHostKey(
  knownHosts: string,
  host: string,
  port: number,
  keyType: string,
  presentedKey: Buffer,
): HostKeyVerdict {
  const presented = presentedKey.toString("base64");
  let sawHost = false;

  for (const rawLine of knownHosts.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Markers such as @cert-authority and @revoked are not supported; skipping
    // them means an unmatched key stays unknown rather than being trusted.
    if (line.startsWith("@")) continue;

    const [hosts, type, key] = line.split(/\s+/);
    if (!hosts || !type || !key) continue;
    if (!hostMatches(hosts, host, port)) continue;

    sawHost = true;
    if (type === keyType && key === presented) return { status: "match" };
  }

  return sawHost ? { status: "mismatch" } : { status: "unknown" };
}
