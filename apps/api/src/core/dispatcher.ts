import type { Clock, Logger, Scheduler } from "./ports.js";
import { CLOSE, type OutboundFrame, type chunkFrame, type doneFrame, type errorFrame } from "./protocol.js";
import type { Registry } from "./registry.js";
import type { Lane } from "./types.js";
import type { z } from "zod";

// In-memory routing and queues (wiki-llm/architecture.md). Pure: it talks to workers through `WorkerLink` and to
// consumers through `JobSink`, so tests drive it with fakes and a manual scheduler.
export const MAX_QUEUED_PER_MODEL = 100;
export const MAX_QUEUE_WAIT_MS = 30_000;
export const FIRST_CHUNK_TIMEOUT_MS = 30_000;
export const JOB_TIMEOUT_MS = 180_000;
/** After a cancel or timeout the worker must confirm with `done`/`error` within this time, or it is dropped. */
export const CANCEL_GRACE_MS = 10_000;
/** A job runs at most twice: one requeue after a failure before the first chunk. */
export const MAX_ATTEMPTS = 2;
/** A worker sending more than max_tokens (+ slack) chunks, or more than this many characters per token, is cut off. */
const CHUNK_SLACK = 8;
const CHARS_PER_TOKEN_LIMIT = 64;

type ChunkFrame = z.infer<typeof chunkFrame>;
type DoneFrame = z.infer<typeof doneFrame>;
type ErrorFrame = z.infer<typeof errorFrame>;
type JobFrame = Extract<OutboundFrame, { type: "job" }>;

/** What the dispatcher needs from the provider sockets (implemented by the ws adapter). */
export interface WorkerLink {
  /** False when the worker has no open socket. */
  send(workerId: string, frame: OutboundFrame): boolean;
  /** Closes the worker's socket with `code`. */
  drop(workerId: string, code: number): void;
}

export interface DispatchModel {
  id: string;
  webllmId: string;
  contextWindow: number;
  priceMultiplier: number;
}

export interface JobRequest {
  jobId: string;
  consumerId: string;
  lane: Lane;
  /** The consumer's balance at admission: orders the fair lane. */
  balance: number;
  model: DispatchModel;
  messages: JobFrame["messages"];
  params: JobFrame["params"];
}

export type FailCode = "provider_failed" | "network_busy" | "no_providers";

export interface JobResult {
  finishReason: "stop" | "length";
  /** Already capped (see economy.md). */
  usage: { promptTokens: number; completionTokens: number; decodeTokensPerS: number };
  providerId: string;
  workerId: string;
}

/** What a consumer-cancelled job still earns the provider: the usage of what was delivered. */
export type CancelResult = Pick<JobResult, "usage" | "providerId" | "workerId">;

/**
 * Callbacks may fire before `submit` returns (a fail-fast). After `cancel` only `onCancelled` fires, exactly once.
 */
export interface JobSink {
  onStart?(info: { providerId: string; workerId: string }): void;
  onChunk(delta: string): void;
  onDone(result: JobResult): void;
  onFail(code: FailCode): void;
  /**
   * After `cancel`: the result to bill when the job had delivered output and the worker confirmed within the grace
   * period (`done`), else undefined (cancelled before any output, worker error, silent or gone).
   */
  onCancelled?(result: CancelResult | undefined): void;
}

export interface JobHandle {
  cancel(): void;
}

export interface Dispatcher {
  /** Late binding: the ws adapter is created after the core. Until set, sends fail. */
  setLink(link: WorkerLink): void;
  submit(req: JobRequest, sink: JobSink): JobHandle;
  /** Sends a frame to a worker (e.g. `stats` after settlement); false when it is gone. */
  send(workerId: string, frame: OutboundFrame): boolean;
  /** Jobs waiting for a worker of this model. */
  queueDepth(webllmId: string): number;
  /** A worker finished `ready`: queued jobs may now run. */
  onWorkerReady(workerId: string): void;
  onChunk(workerId: string, frame: ChunkFrame): void;
  onDone(workerId: string, frame: DoneFrame): void;
  onError(workerId: string, frame: ErrorFrame): void;
  /** The worker left the registry (socket closed, swept, replaced, suspended). */
  onWorkerGone(workerId: string): void;
}

interface Entry {
  req: JobRequest;
  sink: JobSink;
  seq: number;
  attempts: number;
  /** Requeued after a failure: goes before the rest of its lane. */
  boosted: boolean;
  /** The worker that just failed this job: the retry goes elsewhere. */
  avoid?: string;
  /** Queue-wait budget: time spent queued across attempts (ms), and when the current stay began. */
  waited: number;
  queuedAt: number;
  state: "queued" | "running" | "done";
  cancelWait?: () => void;
  run?: Run;
}

interface Run {
  entry: Entry;
  workerId: string;
  providerId: string;
  chunks: number;
  chars: number;
  gotFirst: boolean;
  /** Some output that is not whitespace arrived: an empty answer is not a success. */
  visible: boolean;
  /** Set when the consumer cancelled: resolves the billing question once the worker answers (or fails to). */
  cancelCb?: (result: CancelResult | undefined) => void;
  /** The consumer side ended (cancel, timeout, failure); the worker still has to confirm. */
  detached: boolean;
  cancelFirst?: () => void;
  cancelTotal?: () => void;
  cancelGrace?: () => void;
}

const encoder = new TextEncoder();

/** An upper bound on the prompt's tokens (a token is at least a byte of text; plus chat-template overhead). */
export function promptEstimate(messages: JobFrame["messages"]): number {
  let bytes = 0;
  for (const m of messages) bytes += encoder.encode(m.content).length;
  return bytes + 16 * messages.length + 32;
}

const noLink: WorkerLink = { send: () => false, drop: () => {} };

export function createDispatcher(deps: {
  registry: Registry;
  scheduler: Scheduler;
  clock: Clock;
  log: Logger;
}): Dispatcher {
  const { registry, scheduler, clock, log } = deps;
  const now = () => clock.now().getTime();
  let link: WorkerLink = noLink;
  /** Queued jobs by WebLLM model id. */
  const queues = new Map<string, Entry[]>();
  /** The job each busy worker holds (including cancelled ones awaiting confirmation). */
  const runs = new Map<string, Run>();
  let seq = 0;
  let pumping = false;
  const pending = new Set<string>();

  // A sink that throws must not corrupt the queues.
  const call = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      log.error("job sink failed", { error });
    }
  };

  /** A worker whose socket throws is as good as gone. */
  const trySend = (workerId: string, frame: OutboundFrame): boolean => {
    try {
      return link.send(workerId, frame);
    } catch (error) {
      log.warn("worker send threw", { worker_id: workerId, error });
      return false;
    }
  };

  const order = (a: Entry, b: Entry): number => {
    if (a.req.lane !== b.req.lane) return a.req.lane === "priority" ? -1 : 1;
    if (a.boosted !== b.boosted) return a.boosted ? -1 : 1;
    if (a.req.lane === "fair" && a.req.balance !== b.req.balance) return b.req.balance - a.req.balance;
    return a.seq - b.seq;
  };

  const queueOf = (webllmId: string): Entry[] => {
    let q = queues.get(webllmId);
    if (!q) queues.set(webllmId, (q = []));
    return q;
  };

  function removeQueued(e: Entry): void {
    const q = queues.get(e.req.model.webllmId);
    const at = q ? q.indexOf(e) : -1;
    if (q && at !== -1) q.splice(at, 1);
    e.cancelWait?.();
    e.cancelWait = undefined;
    e.waited += now() - e.queuedAt;
  }

  function enqueue(e: Entry): void {
    e.state = "queued";
    e.queuedAt = now();
    queueOf(e.req.model.webllmId).push(e);
    // The 30 s budget is for the whole time a job spends queued, however many attempts it takes.
    e.cancelWait = scheduler.after(Math.max(0, MAX_QUEUE_WAIT_MS - e.waited), () => {
      if (e.state !== "queued") return;
      removeQueued(e);
      e.state = "done";
      call(() => e.sink.onFail("network_busy"));
    });
  }

  function pump(webllmId: string): void {
    pending.add(webllmId);
    if (pumping) return;
    pumping = true;
    try {
      while (pending.size > 0) {
        const [next] = pending;
        pending.delete(next!);
        drain(next!);
      }
    } finally {
      pumping = false;
    }
  }

  /** Starts as many queued jobs as there are eligible idle workers, best-ranked job first. */
  function drain(webllmId: string): void {
    const q = queues.get(webllmId);
    if (!q) return;
    for (;;) {
      let started = false;
      for (const e of [...q].sort(order)) {
        // The consumer's own worker is never eligible, so a lower-ranked job may be served first.
        const worker = registry.pickRandomIdle(webllmId, e.req.consumerId, e.avoid);
        if (!worker) continue;
        removeQueued(e);
        start(e, worker.id, worker.userId);
        started = true;
        break;
      }
      if (!started) return;
    }
  }

  function clearTimers(run: Run): void {
    run.cancelFirst?.();
    run.cancelTotal?.();
    run.cancelFirst = run.cancelTotal = undefined;
  }

  function start(e: Entry, workerId: string, providerId: string): void {
    const { req } = e;
    e.attempts++;
    e.state = "running";
    registry.markBusy(workerId, req.jobId);
    const run: Run = {
      entry: e,
      workerId,
      providerId,
      chunks: 0,
      chars: 0,
      gotFirst: false,
      visible: false,
      detached: false,
    };
    e.run = run;
    runs.set(workerId, run);
    run.cancelFirst = scheduler.after(FIRST_CHUNK_TIMEOUT_MS, () => timedOut(run, "first_chunk_timeout"));
    run.cancelTotal = scheduler.after(JOB_TIMEOUT_MS, () => timedOut(run, "job_timeout"));
    call(() => e.sink.onStart?.({ providerId, workerId }));
    // Only the messages and whitelisted params: never the consumer's identity.
    const frame: JobFrame = { type: "job", id: req.jobId, messages: req.messages, params: req.params };
    if (!trySend(workerId, frame)) {
      log.warn("job send failed", { job_id: req.jobId, worker_id: workerId });
      broken(run);
      failRun(run);
    }
  }

  /** The consumer side of a run ended while the worker may still be generating: ask it to stop and await its answer. */
  function detach(run: Run): void {
    if (run.detached) return;
    run.detached = true;
    clearTimers(run);
    trySend(run.workerId, { type: "cancel", id: run.entry.req.jobId });
    run.cancelGrace = scheduler.after(CANCEL_GRACE_MS, () => {
      log.warn("worker ignored cancel", { job_id: run.entry.req.jobId, worker_id: run.workerId });
      broken(run);
    });
  }

  /** A worker that does not answer is dropped: it can no longer be trusted with jobs. */
  function broken(run: Run): void {
    clearTimers(run);
    run.cancelGrace?.();
    run.cancelGrace = undefined;
    if (runs.get(run.workerId) === run) runs.delete(run.workerId);
    registry.unregister(run.workerId);
    try {
      link.drop(run.workerId, CLOSE.timeout);
    } catch (error) {
      log.warn("worker drop threw", { worker_id: run.workerId, error });
    }
    resolveCancel(run, undefined);
  }

  /** A consumer-cancelled run is settled one way or the other, once. */
  function resolveCancel(run: Run, result: CancelResult | undefined): void {
    const cb = run.cancelCb;
    run.cancelCb = undefined;
    if (cb) call(() => cb(result));
  }

  /** The worker answered for this job (or is gone): it holds nothing any more. */
  function release(run: Run, idle: boolean): void {
    clearTimers(run);
    run.cancelGrace?.();
    run.cancelGrace = undefined;
    if (runs.get(run.workerId) === run) runs.delete(run.workerId);
    if (idle) registry.markIdle(run.workerId);
    resolveCancel(run, undefined);
  }

  /** Before the first chunk the job gets one more try at the front of its lane; otherwise it fails. */
  function failRun(run: Run): void {
    const e = run.entry;
    if (e.state !== "running" || e.run !== run) return;
    e.run = undefined;
    // The retry needs queue time left; a job that used its whole budget has nothing to retry with.
    if (!run.gotFirst && e.attempts < MAX_ATTEMPTS && e.waited < MAX_QUEUE_WAIT_MS) {
      e.boosted = true;
      e.avoid = run.workerId;
      enqueue(e);
      pump(e.req.model.webllmId);
      return;
    }
    e.state = "done";
    call(() => e.sink.onFail("provider_failed"));
  }

  function timedOut(run: Run, reason: string): void {
    if (runs.get(run.workerId) !== run || run.detached) return;
    log.warn("job timed out", { job_id: run.entry.req.jobId, worker_id: run.workerId, reason });
    detach(run);
    failRun(run);
  }

  const current = (workerId: string, jobId: string): Run | undefined => {
    const run = runs.get(workerId);
    return run && run.entry.req.jobId === jobId ? run : undefined;
  };

  function cap(run: Run, reported: DoneFrame["usage"]): JobResult["usage"] {
    const { req } = run.entry;
    const completionTokens = Math.min(reported.completionTokens, req.params.max_tokens ?? Infinity, run.chunks);
    const promptTokens = Math.min(reported.promptTokens, req.model.contextWindow, promptEstimate(req.messages));
    if (completionTokens !== reported.completionTokens || promptTokens !== reported.promptTokens) {
      log.warn("usage_capped", {
        job_id: req.jobId,
        worker_id: run.workerId,
        reported_prompt_tokens: reported.promptTokens,
        reported_completion_tokens: reported.completionTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      });
    }
    return { promptTokens, completionTokens, decodeTokensPerS: reported.decodeTokensPerS };
  }

  return {
    setLink(next) {
      link = next;
    },

    send: (workerId, frame) => trySend(workerId, frame),

    submit(req, sink) {
      const e: Entry = { req, sink, seq: seq++, attempts: 0, boosted: false, waited: 0, queuedAt: 0, state: "queued" };
      const handle: JobHandle = {
        cancel() {
          if (e.state === "queued") {
            removeQueued(e);
            e.state = "done";
            call(() => sink.onCancelled?.(undefined));
          } else if (e.state === "running" && e.run) {
            const run = e.run;
            e.state = "done";
            e.run = undefined;
            // Output the consumer already received is paid for once the worker confirms (its `done` carries the usage).
            const billable = run.visible;
            run.cancelCb = (result) => sink.onCancelled?.(billable ? result : undefined);
            detach(run);
          }
        },
      };
      const webllmId = req.model.webllmId;
      if (registry.onlineCount(webllmId) === 0) {
        e.state = "done";
        call(() => sink.onFail("no_providers"));
        return handle;
      }
      enqueue(e);
      pump(webllmId);
      if (e.state === "queued" && queueOf(webllmId).length > MAX_QUEUED_PER_MODEL) {
        removeQueued(e);
        e.state = "done";
        call(() => sink.onFail("network_busy"));
      }
      return handle;
    },

    queueDepth: (webllmId) => queues.get(webllmId)?.length ?? 0,

    onWorkerReady(workerId) {
      const model = registry.get(workerId)?.model;
      if (model) pump(model.webllmId);
    },

    onChunk(workerId, frame) {
      const run = current(workerId, frame.id);
      if (!run || run.detached || frame.delta === "") return;
      const { req } = run.entry;
      run.chunks++;
      run.chars += frame.delta.length;
      if (!run.visible && /\S/.test(frame.delta)) run.visible = true;
      const maxTokens = req.params.max_tokens ?? Infinity;
      if (run.chunks > maxTokens + CHUNK_SLACK || run.chars > maxTokens * CHARS_PER_TOKEN_LIMIT) {
        // Untrusted provider: more output than the request allows. Cut it off; the worker confirms or is dropped.
        log.warn("job output over limit", { job_id: req.jobId, worker_id: workerId, chunks: run.chunks });
        detach(run);
        failRun(run);
        return;
      }
      if (!run.gotFirst) {
        run.gotFirst = true;
        run.cancelFirst?.();
        run.cancelFirst = undefined;
      }
      call(() => run.entry.sink.onChunk(frame.delta));
    },

    onDone(workerId, frame) {
      const run = current(workerId, frame.id);
      if (!run) return;
      const e = run.entry;
      const model = e.req.model.webllmId;
      const usage = cap(run, frame.usage);
      if (run.detached) {
        // Consumer cancelled: the confirmation settles what was delivered (resolveCancel inside release otherwise).
        resolveCancel(run, { usage, providerId: run.providerId, workerId });
      }
      release(run, true);
      const { finishReason } = frame;
      if (!run.detached) {
        if (finishReason === "abort" || !run.visible) {
          // The worker stopped on its own, or answered with nothing: not a completed answer.
          failRun(run);
        } else {
          e.state = "done";
          e.run = undefined;
          call(() => e.sink.onDone({ finishReason, usage, providerId: run.providerId, workerId }));
        }
      }
      pump(model);
    },

    onError(workerId, frame) {
      const run = current(workerId, frame.id);
      if (!run) return;
      const detached = run.detached;
      release(run, true);
      log.info("worker job error", { job_id: frame.id, worker_id: workerId, code: frame.code });
      if (!detached) failRun(run);
      pump(run.entry.req.model.webllmId);
    },

    onWorkerGone(workerId) {
      const run = runs.get(workerId);
      if (!run) return;
      release(run, false);
      if (!run.detached) failRun(run);
    },
  };
}
