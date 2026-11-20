import { DEFAULT_CONTEXT_WINDOW } from "./models.js";
import type { Gpu } from "./protocol.js";
import type { Clock, Secrets } from "./ports.js";

export const MAX_WORKERS_PER_USER = 4;
export const MAX_WORKERS_TOTAL = 5_000;
/** A worker silent for longer than this is dropped (heartbeats come every 5 s). */
export const SILENCE_MS = 15_000;
/** `last_seen_at` is written at most this often. */
export const PERSIST_EVERY_MS = 60_000;

/** `ready` = announced and idle. */
export type WorkerState = "connected" | "ready" | "busy";

export interface LiveWorker {
  id: string;
  userId: string;
  deviceKey: string;
  state: WorkerState;
  connectedAt: Date;
  /** Set once `ready` is accepted. */
  model: { id: string; webllmId: string } | null;
  gpu: Gpu | null;
  /** Tokens of context the worker loaded (set at `ready`; 4096 for tabs that do not say). */
  contextWindow: number;
  jobId: string | null;
  /** Set when the owner is found suspended: the worker is no longer offered jobs. */
  suspended: boolean;
  lastSeen: number;
  lastPersisted: number;
}

export interface Registry {
  /** Would `register` accept this device? (A reconnecting device replaces its old entry.) */
  canRegister(userId: string, deviceKey: string): boolean;
  /** Same worker id twice means the device reconnected: the old entry is replaced (`replaced: true`). */
  register(id: string, userId: string, deviceKey: string): { ok: true; replaced: boolean } | { ok: false };
  /** connected -> ready (idle); false in any other state. */
  markReady(id: string, model: { id: string; webllmId: string }, gpu: Gpu, contextWindow?: number): boolean;
  markBusy(id: string, jobId: string): boolean;
  markIdle(id: string): boolean;
  /** Records a sign of life; true when the caller should persist `last_seen_at` now. */
  heartbeat(id: string): boolean;
  unregister(id: string): void;
  /** Flags every live worker of the user so `pickRandomIdle` skips them until they disconnect. */
  markSuspended(userId: string): void;
  /** Drops workers silent for more than SILENCE_MS and returns them (the adapter closes their sockets). */
  sweep(): LiveWorker[];
  get(id: string): LiveWorker | undefined;
  byUser(userId: string): LiveWorker[];
  /** Workers that can serve some model (ready or busy). */
  readyCount(): number;
  /** Workers that can serve this WebLLM model (ready or busy), without those of `excludeUserId` when given. */
  onlineCount(webllmId: string, excludeUserId?: string, minContext?: number): number;
  /**
   * A random idle worker for the model, never one owned by `excludeUserId` (a consumer is not served by itself) nor
   * `excludeWorkerId`, and only one whose loaded window is at least `minContext` tokens.
   */
  pickRandomIdle(
    webllmId: string,
    excludeUserId: string,
    excludeWorkerId?: string,
    minContext?: number,
  ): LiveWorker | undefined;
  size(): number;
}

export function createRegistry(deps: {
  clock: Clock;
  secrets: Secrets;
  maxPerUser?: number;
  maxTotal?: number;
}): Registry {
  const { clock, secrets } = deps;
  const maxPerUser = deps.maxPerUser ?? MAX_WORKERS_PER_USER;
  const maxTotal = deps.maxTotal ?? MAX_WORKERS_TOTAL;
  const workers = new Map<string, LiveWorker>();
  const now = () => clock.now().getTime();

  const owned = (userId: string) => [...workers.values()].filter((w) => w.userId === userId);
  const room = (userId: string, replacing: boolean) =>
    replacing || (workers.size < maxTotal && owned(userId).length < maxPerUser);

  return {
    canRegister(userId, deviceKey) {
      const replacing = owned(userId).some((w) => w.deviceKey === deviceKey);
      return room(userId, replacing);
    },
    register(id, userId, deviceKey) {
      const replacing = workers.has(id);
      if (!room(userId, replacing)) return { ok: false };
      const t = now();
      workers.set(id, {
        id,
        userId,
        deviceKey,
        state: "connected",
        connectedAt: clock.now(),
        model: null,
        gpu: null,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        jobId: null,
        suspended: false,
        lastSeen: t,
        lastPersisted: t,
      });
      return { ok: true, replaced: replacing };
    },
    markReady(id, model, gpu, contextWindow = DEFAULT_CONTEXT_WINDOW) {
      const w = workers.get(id);
      if (!w || w.state !== "connected") return false;
      w.state = "ready";
      w.model = model;
      w.gpu = gpu;
      w.contextWindow = contextWindow;
      return true;
    },
    markBusy(id, jobId) {
      const w = workers.get(id);
      if (!w || w.state !== "ready") return false;
      w.state = "busy";
      w.jobId = jobId;
      return true;
    },
    markIdle(id) {
      const w = workers.get(id);
      if (!w || w.state !== "busy") return false;
      w.state = "ready";
      w.jobId = null;
      return true;
    },
    heartbeat(id) {
      const w = workers.get(id);
      if (!w) return false;
      const t = now();
      w.lastSeen = t;
      if (t - w.lastPersisted < PERSIST_EVERY_MS) return false;
      w.lastPersisted = t;
      return true;
    },
    unregister(id) {
      workers.delete(id);
    },
    markSuspended(userId) {
      for (const w of owned(userId)) w.suspended = true;
    },
    sweep() {
      const t = now();
      const dropped: LiveWorker[] = [];
      for (const w of workers.values()) {
        if (t - w.lastSeen > SILENCE_MS) dropped.push(w);
      }
      for (const w of dropped) workers.delete(w.id);
      return dropped;
    },
    get: (id) => workers.get(id),
    byUser: owned,
    readyCount() {
      let n = 0;
      for (const w of workers.values()) if (w.state !== "connected") n++;
      return n;
    },
    onlineCount(webllmId, excludeUserId, minContext = 0) {
      let n = 0;
      for (const w of workers.values()) {
        if (
          w.state !== "connected" &&
          w.model?.webllmId === webllmId &&
          w.userId !== excludeUserId &&
          w.contextWindow >= minContext
        )
          n++;
      }
      return n;
    },
    pickRandomIdle(webllmId, excludeUserId, excludeWorkerId, minContext = 0) {
      const eligible = [...workers.values()].filter(
        (w) =>
          w.state === "ready" &&
          !w.suspended &&
          w.model?.webllmId === webllmId &&
          w.userId !== excludeUserId &&
          w.id !== excludeWorkerId &&
          w.contextWindow >= minContext,
      );
      return eligible.length === 0 ? undefined : eligible[secrets.int(eligible.length)];
    },
    size: () => workers.size,
  };
}
