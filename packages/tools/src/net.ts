import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { ToolError } from "./errors";

/**
 * Addresses tools must never reach unless explicitly allowed (development/tests):
 * loopback, private ranges, link-local (cloud metadata), CGNAT, multicast, unspecified.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    /^fe[89ab]/.test(v6) ||
    v6.startsWith("ff") ||
    v6.startsWith("64:ff9b:")
  );
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `lookup` for http/https/net that refuses private addresses. Used as the socket's own resolver,
 * so the address checked is the address connected to (no DNS-rebinding gap).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as { address: string; family: number }[];
      const bad = !allowPrivate && list.find((a) => isPrivateAddress(a.address));
      if (bad || !list.length) {
        const e = new ToolError(
          "blocked",
          `${hostname} resolves to a private address`,
        ) as unknown as NodeJS.ErrnoException;
        return callback(e, []);
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** Resolve a host once and return an address that is safe to connect to */
export async function resolvePublic(hostname: string, allowPrivate: boolean): Promise<string> {
  if (isIP(hostname)) {
    if (!allowPrivate && isPrivateAddress(hostname))
      throw new ToolError("blocked", "Private addresses are not allowed");
    return hostname;
  }
  return new Promise((resolve, reject) =>
    guardedLookup(allowPrivate)(hostname, {}, (err, address) =>
      err
        ? reject(err instanceof ToolError ? err : new ToolError("config", `Cannot resolve ${hostname}`))
        : resolve(address as string),
    ),
  );
}
