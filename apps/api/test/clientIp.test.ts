import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIp, limiterKey } from "../src/adapters/http/clientIp.js";

describe("limiterKey", () => {
  it("leaves IPv4 alone and unwraps IPv4-mapped IPv6", () => {
    expect(limiterKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
  });

  it("keys IPv6 on the /64 prefix, however it is written", () => {
    const key = "2001:db8:1:2::/64";
    expect(limiterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(key);
    expect(limiterKey("2001:DB8:1:2::1")).toBe(key);
    expect(limiterKey("2001:db8:1:2:0:0:0:ffff")).toBe(key);
    expect(limiterKey("2001:db8:1:3::1")).not.toBe(key);
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("uses what it cannot parse as is", () => {
    expect(limiterKey("unknown")).toBe("unknown");
    expect(limiterKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(limiterKey("::g")).toBe("::g");
  });
});

describe("clientIp", () => {
  const req = (remote: string, realIp?: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: realIp ? { "x-real-ip": realIp } : {},
    }) as unknown as IncomingMessage;

  it("reads X-Real-IP only with trustProxy, and normalises either source", () => {
    expect(clientIp(req("::ffff:10.0.0.9", "2001:db8::5"), false)).toBe("10.0.0.9");
    expect(clientIp(req("::ffff:10.0.0.9", "2001:db8::5"), true)).toBe("2001:db8:0:0::/64");
    expect(clientIp(req("10.0.0.9"), true)).toBe("10.0.0.9");
  });
});
