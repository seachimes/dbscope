import { Client, type ConnectConfig } from "ssh2";
import net from "node:net";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectRequest } from "#shared/types.ts";
import { verifyHostKey } from "./known-hosts.ts";

export interface Tunnel {
  /** Local endpoint that now stands in for the remote MySQL. */
  host: string;
  port: number;
  close: () => Promise<void>;
}

type SshConfig = NonNullable<ConnectRequest["ssh"]>;

/**
 * A private key may arrive as PEM text or as a path. Accepting both removes a
 * papercut: people often paste a `~/.ssh/...` path rather than the key body.
 */
export function resolveKey(input: string): Buffer {
  const trimmed = input.trim();
  if (trimmed.includes("PRIVATE KEY")) return Buffer.from(trimmed + "\n", "utf8");

  // Never let an API request select an arbitrary server file. Resolve symlinks
  // first, then allow only ~/.ssh and the local fixture's generated key.
  const sshDir = join(homedir(), ".ssh");
  const fixtureKey = fileURLToPath(new URL("../../fixture/ssh/id_ed25519", import.meta.url));
  const requested = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(requested) && !trimmed.startsWith("~/")) {
    throw new Error("SSH key path must be absolute or start with ~/");
  }
  let path: string;
  try {
    path = realpathSync(requested);
  } catch {
    throw new Error("SSH private key file could not be read");
  }
  const inside = relative(sshDir, path);
  if (
    path !== fixtureKey &&
    (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
  ) {
    throw new Error("SSH private key path must be under ~/.ssh");
  }
  return readFileSync(path);
}

/**
 * Verify the server's host key against the user's own known_hosts.
 *
 * ssh2 accepts any host key by default, which silently gives up the protection
 * SSH exists to provide. The verifier below fails closed: a host that is not in
 * known_hosts, or one whose key has changed, is rejected unless the caller has
 * explicitly opted into the insecure policy.
 */
function hostVerifierFor(
  ssh: SshConfig,
  port: number,
  onError: (reason: string | null) => void,
): (key: Buffer) => boolean {
  if (ssh.hostKeyPolicy === "insecure") return () => true;

  const path = process.env.DBSCOPE_KNOWN_HOSTS ?? join(homedir(), ".ssh", "known_hosts");

  return (key: Buffer) => {
    let knownHosts: string;
    try {
      knownHosts = readFileSync(path, "utf8");
    } catch {
      onError(
        `no known_hosts file at ${path}. Connect once with ssh to record the host key, or re-connect with host key checking disabled if you accept the risk.`,
      );
      return false;
    }

    // ssh2 hands over the key blob; its type is the first length-prefixed
    // string inside it, exactly as known_hosts records it.
    const typeLength = key.readUInt32BE(0);
    const keyType = key.subarray(4, 4 + typeLength).toString("utf8");
    const verdict = verifyHostKey(knownHosts, ssh.host, port, keyType, key);

    if (verdict.status === "match") {
      onError(null);
      return true;
    }
    onError(
      verdict.status === "mismatch"
        ? `the host key for ${ssh.host} does not match the one in ${path}. This can mean the server was rebuilt, or that the connection is being intercepted. Verify the new key before trusting it.`
        : `${ssh.host} is not in ${path}. Connect once with ssh to record its host key, or re-connect with host key checking disabled if you accept the risk.`,
    );
    return false;
  };
}

/**
 * Open an SSH connection and a local TCP listener that forwards every accepted
 * socket to remoteHost:remotePort *from the VM's point of view*.
 *
 * Port 0 lets the OS pick a free port, which avoids collisions when several
 * sessions are open at once.
 */
export async function openTunnel(
  ssh: SshConfig,
  remoteHost: string,
  remotePort: number,
): Promise<Tunnel> {
  const conn = new Client();

  const port = ssh.port || 22;
  let hostKeyError: string | null = null;
  const config: ConnectConfig = {
    host: ssh.host,
    port,
    username: ssh.user,
    privateKey: resolveKey(ssh.privateKey),
    readyTimeout: 20_000,
    keepaliveInterval: 10_000,
    hostVerifier: hostVerifierFor(ssh, port, (reason) => {
      hostKeyError = reason;
    }),
  };
  if (ssh.passphrase) config.passphrase = ssh.passphrase;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      conn.removeListener("ready", onReady);
      // A rejected host key surfaces as a generic handshake failure, so replace
      // it with the reason the verifier actually recorded.
      reject(
        new Error(
          hostKeyError
            ? `SSH host key verification failed: ${hostKeyError}`
            : `SSH connection failed: ${err.message}`,
        ),
      );
    };
    const onReady = () => {
      conn.removeListener("error", onError);
      resolve();
    };
    conn.once("ready", onReady);
    conn.once("error", onError);
    conn.connect(config);
  });

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A forwardOut failure destroys this socket with an error. Install the
    // handler before opening the channel so a bad remote host/port becomes a
    // normal MySQL connection error instead of crashing the entire API process.
    socket.on("error", (err) => {
      console.warn("[tunnel] forwarded socket closed:", err.message);
    });
    // srcIP/srcPort are informational to the remote sshd; the pair below is
    // truthful enough and keeps the remote logs readable.
    conn.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (err, stream) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      socket.pipe(stream).pipe(socket);
      // A half-open socket on either side must not strand the other.
      stream.on("error", () => socket.destroy());
      socket.on("error", () => stream.destroy());
    });
  });

  // Errors on idle forwarded sockets must never take the process down.
  server.on("error", (err) => {
    console.error("[tunnel] local listener error:", err.message);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    server.close();
    conn.end();
    throw new Error("failed to bind a local tunnel port");
  }

  let closed = false;
  const close = () =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        conn.end();
        resolve();
      });
      // server.close() normally resolves immediately after destroying tracked
      // sockets; this fallback prevents shutdown hanging on an unknown handle.
      setTimeout(() => {
        conn.destroy();
        resolve();
      }, 1_000).unref();
    });

  // If the SSH link dies, tear the listener down rather than accepting
  // connections that can no longer be forwarded.
  conn.on("close", () => {
    if (!closed) {
      closed = true;
      server.close();
    }
  });

  return { host: "127.0.0.1", port: address.port, close };
}

/** Verify SSH credentials without leaving anything running. */
export async function testSsh(ssh: SshConfig): Promise<void> {
  const tunnel = await openTunnel(ssh, "127.0.0.1", 3306);
  await tunnel.close();
}
