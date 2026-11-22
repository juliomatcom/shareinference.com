import type { Deps } from "./deps.js";
import { sanitizeGpu } from "./gpu.js";
import { CLOSE, type AuthFrame, type ReadyFrame } from "./protocol.js";

export type WorkerAuth =
  { ok: true; workerId: string; userId: string; replaced: boolean } | { ok: false; close: number };

/**
 * The first frame: redeems the single-use token, checks the account and the per-user limit, upserts the durable
 * `workers` row and registers the live worker (state `connected`).
 */
export async function authenticateWorker(
  deps: Deps,
  frame: AuthFrame,
  /** Is the socket still open? A dead one must never reach the registry (it would replace a live entry). */
  isAlive: () => boolean,
): Promise<WorkerAuth> {
  const userId = deps.workerTokens.redeem(frame.token);
  if (!userId) return { ok: false, close: CLOSE.unauthorized };
  const user = await deps.users.findById(userId);
  if (!user || user.suspendedAt) return { ok: false, close: CLOSE.unauthorized };
  // Checked before the upsert so refused devices leave no row; `register` re-checks (the await above can race).
  if (!deps.registry.canRegister(userId, frame.deviceKey)) return { ok: false, close: CLOSE.tooMany };
  const workerId = await deps.workers.upsert(userId, frame.deviceKey, deps.clock.now());
  // The last await is behind us: check and register in one synchronous step.
  if (!isAlive()) return { ok: false, close: CLOSE.unauthorized };
  const registered = deps.registry.register(workerId, userId, frame.deviceKey);
  if (!registered.ok) return { ok: false, close: CLOSE.tooMany };
  return { ok: true, workerId, userId, replaced: registered.replaced };
}

/** `ready`: the model must be an enabled catalog row (by `ggufRef`). Returns the close code on refusal. */
export async function workerReady(
  deps: Deps,
  workerId: string,
  frame: ReadyFrame,
  /** Still the device's current socket? A replaced one must not touch the new connection's entry. */
  isCurrent: () => boolean,
): Promise<{ ok: true } | { ok: false; close: number }> {
  const model = await deps.models.findEnabledByGgufRef(frame.model);
  if (!model) return { ok: false, close: CLOSE.unknownModel };
  // The device strings are shown publicly: store only the cleaned ones.
  const gpu = sanitizeGpu(frame.gpu);
  // Second `ready`, replaced or dropped meanwhile.
  if (
    !isCurrent() ||
    !deps.registry.markReady(workerId, { id: model.id, ggufRef: model.ggufRef }, gpu, frame.contextWindow)
  ) {
    return { ok: false, close: CLOSE.badFrame };
  }
  await deps.workers.setReady(workerId, gpu, model.ggufRef, deps.clock.now());
  return { ok: true };
}

/**
 * A heartbeat: refreshes the live entry. Once a minute it also writes `last_seen_at` and re-checks the owner: a user
 * suspended after connecting is flagged (no more jobs) and the caller closes the socket.
 */
export async function workerHeartbeat(deps: Deps, workerId: string): Promise<"ok" | "suspended"> {
  if (!deps.registry.heartbeat(workerId)) return "ok";
  const worker = deps.registry.get(workerId);
  await deps.workers.touch(workerId, deps.clock.now());
  if (!worker) return "ok";
  const owner = await deps.users.findById(worker.userId);
  if (owner && !owner.suspendedAt) return "ok";
  deps.registry.markSuspended(worker.userId);
  return "suspended";
}

export interface PublicModel {
  id: string;
  ggufRef: string;
  contextWindow: number;
  /** Credit multiplier (wiki-llm/economy.md); the Playground computes its per-reply credits from it. */
  priceMultiplier: number;
  workersOnline: number;
  /** Jobs waiting for a worker of this model. */
  queueDepth: number;
}

export async function publicModels(deps: Deps): Promise<PublicModel[]> {
  const models = await deps.models.listEnabled();
  return models.map((m) => ({
    id: m.id,
    ggufRef: m.ggufRef,
    contextWindow: m.contextWindow,
    priceMultiplier: m.priceMultiplier,
    workersOnline: deps.registry.onlineCount(m.ggufRef),
    queueDepth: deps.dispatcher.queueDepth(m.ggufRef),
  }));
}

export interface OwnWorkerStats {
  totals: { jobsServed: number; promptTokens: number; completionTokens: number; creditsEarned: number };
  workers: { id: string; status: "connected" | "ready" | "busy"; model: string | null; connectedAt: Date }[];
}

/** The caller's own provider view. */
export async function ownWorkerStats(deps: Deps, userId: string): Promise<OwnWorkerStats> {
  return {
    totals: await deps.jobs.providerTotals(userId),
    workers: deps.registry.byUser(userId).map((w) => ({
      id: w.id,
      status: w.state,
      model: w.model?.id ?? null,
      connectedAt: w.connectedAt,
    })),
  };
}
