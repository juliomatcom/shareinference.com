import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Clock, Scheduler, Secrets } from "../core/ports.js";

export const nodeSecrets: Secrets = {
  token: () => randomBytes(32).toString("base64url"),
  hex: (bytes) => randomBytes(bytes).toString("hex"),
  int: (max) => randomInt(max),
  hash: (value) => createHash("sha256").update(value).digest("hex"),
};

export const systemClock: Clock = { now: () => new Date() };

/** Timers never keep the process alive on their own. */
export const timerScheduler: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
