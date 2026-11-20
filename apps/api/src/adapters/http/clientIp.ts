import type { IncomingMessage } from "node:http";

/**
 * The key per-IP limits use for an address: IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the plain IPv4 address, and any other
 * IPv6 address is its /64 prefix (one subscriber owns a whole /64, so per-address keys would be free to rotate).
 * Anything unparseable is used as is.
 */
export function limiterKey(address: string): string {
  const addr = address.trim().toLowerCase().split("%")[0]!;
  if (!addr.includes(":")) return addr;
  const halves = addr.split("::");
  if (halves.length > 2) return addr;
  // A dotted IPv4 tail counts as two groups.
  const groups = (part: string | undefined): string[] | null => {
    if (!part) return [];
    const out: string[] = [];
    for (const g of part.split(":")) {
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      if (v4) {
        const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
        if (Math.max(a, b, c, d) > 255) return null;
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(g);
      else return null;
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return addr;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return addr;
  const full = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((g) =>
    parseInt(g, 16),
  );
  if (full.slice(0, 5).every((g) => g === 0) && full[5] === 0xffff) {
    return `${full[6]! >> 8}.${full[6]! & 255}.${full[7]! >> 8}.${full[7]! & 255}`;
  }
  return `${full
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * The caller's address for per-IP limits (as a `limiterKey`). Behind the reverse proxy (`trustProxy`) it is the
 * `X-Real-IP` header the proxy sets itself; otherwise, or when the header is absent, the socket's remote address. A
 * client-supplied header is never trusted without `trustProxy`.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-real-ip"];
    const value = (Array.isArray(header) ? header[0] : header)?.trim();
    if (value && value.length <= 64) return limiterKey(value);
  }
  return limiterKey(req.socket.remoteAddress ?? "unknown");
}
