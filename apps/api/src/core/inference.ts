import { DEFAULT_MAX_TOKENS, jobParams, promptTokenEstimate, type ChatRequest } from "./chat.js";
import type { Deps } from "./deps.js";
import {
  JOB_TIMEOUT_MS,
  PLAYGROUND_JOB_TIMEOUT_MS,
  type CancelResult,
  type FailCode,
  type JobHandle,
  type JobResult,
} from "./dispatcher.js";
import { clampTps } from "./gpu.js";
import { firstChunkTimeoutMs } from "./models.js";
import { creditsFor } from "./pricing.js";
import type { JobSource, Lane, User } from "./types.js";

/** Fair-lane accounts must be at least this old (wiki-llm/economy.md). */
export const MIN_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ChatRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 429 | 503;
  code: "invalid_request" | "model_not_found" | "account_too_new" | "rate_limited" | "no_providers";
  message: string;
};

export type ChatStart = { ok: true; jobId: string; cancel(): void } | ChatRefusal;

/** What the HTTP layer receives: chunks as the provider sends them (raw text), then done or fail. */
export interface ChatSink {
  onChunk(delta: string): void;
  onDone(result: Pick<JobResult, "finishReason" | "usage">): void;
  onFail(code: FailCode): void;
}

/** Database writes of jobs that have not finished: shutdown waits for them before closing the pool. */
const inflight = new Set<Promise<unknown>>();
export async function drainInflightWrites(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

const SETTLE_ATTEMPTS = 3;
const SETTLE_BACKOFF_MS = [100, 400];

const refuse = (status: ChatRefusal["status"], code: ChatRefusal["code"], message: string): ChatRefusal => ({
  ok: false,
  status,
  code,
  message,
});

/** Enabled models with at least one ready or busy worker (`GET /v1/models`). */
export async function onlineModels(deps: Deps): Promise<{ id: string }[]> {
  const models = await deps.models.listEnabled();
  return models.filter((m) => deps.registry.onlineCount(m.ggufRef) > 0);
}

/** Room a worker must have for the reply when the request names no `max_tokens` (the rest of the default may be cut). */
const MIN_REPLY_TOKENS = 1024;

/**
 * Admission, then the job: model lookup, lane from the balance, free-tier account age, rate limits, a `jobs` row, and
 * the dispatcher. `sinkFor` gets the job id (used in response ids) and receives every later event; nothing is called
 * after `cancel`. `source` only labels the job row (the same admission, limits and billing apply to every source). Credits move only on a completed job (one settlement transaction).
 */
export async function startChat(
  deps: Deps,
  user: User,
  source: JobSource,
  body: ChatRequest,
  sinkFor: (jobId: string) => ChatSink,
): Promise<ChatStart> {
  const model = await deps.models.findEnabledById(body.model);
  if (!model) return refuse(404, "model_not_found", `The model '${body.model}' does not exist`);
  // Without max_tokens the reply gets the default, trimmed to what the window leaves after the prompt (a long prompt
  // with no explicit max_tokens still fits). An explicit max_tokens is the client's choice and must fit as is.
  const promptEstimateTokens = promptTokenEstimate(body);
  const maxTokens = body.max_tokens ?? Math.min(DEFAULT_MAX_TOKENS, model.contextWindow - promptEstimateTokens);
  if (maxTokens < 1 || promptEstimateTokens + maxTokens > model.contextWindow) {
    return refuse(
      400,
      "invalid_request",
      `The messages plus max_tokens exceed this model's context length of ${model.contextWindow} tokens`,
    );
  }
  // A consumer is never routed to its own worker, so its own GPU alone is the same as nobody serving. Only workers
  // that loaded a window big enough for this job count (a tab started before a window increase still has the old one).
  // The prompt must fit as is; a reply that outgrows a smaller window just ends there (finish `length`), so without an
  // explicit max_tokens a worker needs room for the prompt plus a minimum reply, not the whole default.
  const needed = promptEstimateTokens + (body.max_tokens ?? Math.min(maxTokens, MIN_REPLY_TOKENS));
  if (deps.registry.onlineCount(model.ggufRef, user.id, needed) === 0) {
    const own = deps.registry.onlineCount(model.ggufRef, undefined, needed) > 0;
    const small = deps.registry.onlineCount(model.ggufRef, user.id) > 0;
    return refuse(
      503,
      "no_providers",
      own
        ? "Only your own GPU is serving this model right now, and you cannot be routed to yourself. Try again when other providers are online."
        : small
          ? "The providers online run a smaller context window than this request needs. Try a shorter request, or try again soon."
          : "No provider is serving this model right now",
    );
  }

  const balance = (await deps.ledger.balance(user.id)) ?? 0;
  const lane: Lane = balance > 0 ? "priority" : "fair";
  if (lane === "fair" && deps.clock.now().getTime() - user.githubCreatedAt.getTime() < MIN_ACCOUNT_AGE_MS) {
    return refuse(
      403,
      "account_too_new",
      "Your GitHub account is too new to use the fair queue; earn credits by sharing your GPU, or try again once it is 30 days old",
    );
  }
  const release = deps.limiter.acquire(user.id, lane, user.rateLimitOverride);
  if (!release) return refuse(429, "rate_limited", "Rate limit exceeded; slow down and retry later");

  let jobId: string;
  try {
    jobId = await deps.jobs.create({ consumerId: user.id, modelId: model.id, lane, source });
  } catch (error) {
    release();
    throw error;
  }

  const sink = sinkFor(jobId);
  const { priceMultiplier } = model;
  const { log } = deps;
  // Database writes of one job run in order (a late `markRunning` must not overwrite the settlement).
  let tail: Promise<unknown> = Promise.resolve();
  const write = (what: string, fn: () => Promise<unknown>): Promise<unknown> => {
    const p: Promise<unknown> = (tail = tail
      .then(fn)
      .catch((error) => log.error(`job ${what} failed`, { job_id: jobId, error })));
    inflight.add(p);
    void p.then(() => inflight.delete(p));
    return p;
  };
  let ended = false;

  /** Settlement is idempotent, so a transient database failure is retried; `lost` means every attempt failed. */
  async function settle(result: CancelResult, credits: number): Promise<"settled" | "duplicate" | "closed" | "lost"> {
    const { usage } = result;
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
      try {
        return await deps.jobs.settle({
          jobId,
          consumerId: user.id,
          providerId: result.providerId,
          credits,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          decodeTps: clampTps(usage.decodeTokensPerS),
          at: deps.clock.now(),
        });
      } catch (error) {
        log.warn("job settle attempt failed", { job_id: jobId, attempt, error });
        if (attempt < SETTLE_ATTEMPTS) {
          await new Promise<void>((resolve) => deps.scheduler.after(SETTLE_BACKOFF_MS[attempt - 1]!, resolve));
        }
      }
    }
    log.error("settle_lost", {
      job_id: jobId,
      consumer_id: user.id,
      provider_id: result.providerId,
      credits,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
    });
    try {
      await deps.jobs.finish(jobId, "failed", "settle_failed", deps.clock.now());
    } catch (error) {
      log.error("job finish failed", { job_id: jobId, error });
    }
    return "lost";
  }

  /** Settle a finished (or delivered-then-cancelled) job and tell the provider its totals. */
  async function settleAndReport(result: CancelResult): Promise<"settled" | "duplicate" | "closed" | "lost"> {
    const { usage } = result;
    const credits = creditsFor(usage.promptTokens, usage.completionTokens, priceMultiplier);
    const settled = await settle(result, credits);
    if (settled === "lost") return settled;
    log.info("job settled", {
      job_id: jobId,
      consumer_id: user.id,
      provider_id: result.providerId,
      status: settled,
      credits,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
    });
    if (settled === "settled") {
      try {
        const totals = await deps.jobs.providerTotals(result.providerId);
        deps.dispatcher.send(result.workerId, {
          type: "stats",
          ...totals,
          lastJob: {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            decodeTokensPerS: usage.decodeTokensPerS,
            credits,
          },
        });
      } catch (error) {
        // The provider's live view only; the settlement stands.
        log.warn("provider stats failed", { job_id: jobId, error });
      }
    }
    return settled;
  }

  const handle: JobHandle = deps.dispatcher.submit(
    {
      jobId,
      consumerId: user.id,
      lane,
      balance,
      source,
      minContext: needed,
      firstChunkTimeoutMs: firstChunkTimeoutMs(
        model.id,
        promptEstimateTokens,
        source === "playground" ? PLAYGROUND_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS,
      ),
      model: {
        id: model.id,
        ggufRef: model.ggufRef,
        contextWindow: model.contextWindow,
        priceMultiplier: model.priceMultiplier,
      },
      messages: body.messages,
      params: jobParams(body, maxTokens),
    },
    {
      onStart({ providerId, workerId }) {
        void write("start", () => deps.jobs.markRunning(jobId, providerId, workerId, deps.clock.now()));
      },
      onChunk: (delta) => sink.onChunk(delta),
      onDone(result) {
        ended = true;
        release();
        void write("settle", async () => {
          const outcome = await settleAndReport(result);
          // Never hand over a completion that could not be charged for.
          if (outcome === "lost") sink.onFail("provider_failed");
          else sink.onDone(result);
        });
      },
      onFail(code) {
        ended = true;
        release();
        void write("finish", () => deps.jobs.finish(jobId, "failed", code, deps.clock.now()));
        sink.onFail(code);
      },
      onCancelled(result) {
        // The consumer left. Output it already received is paid for; before any output nothing moves.
        void write(result ? "settle" : "finish", async () => {
          if (result) await settleAndReport(result);
          else await deps.jobs.finish(jobId, "cancelled", "client_cancelled", deps.clock.now());
        });
      },
    },
  );

  return {
    ok: true,
    jobId,
    cancel() {
      if (ended) return;
      ended = true;
      release();
      handle.cancel();
    },
  };
}
