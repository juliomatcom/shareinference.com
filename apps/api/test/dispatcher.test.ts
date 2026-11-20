import { describe, expect, it, vi } from "vitest";
import { nodeSecrets } from "../src/adapters/secrets.js";
import {
  CANCEL_GRACE_MS,
  FIRST_CHUNK_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  MAX_QUEUED_PER_MODEL,
  MAX_QUEUE_WAIT_MS,
  createDispatcher,
  type CancelResult,
  type FailCode,
  type JobRequest,
  type JobResult,
  type JobSink,
  type WorkerLink,
} from "../src/core/dispatcher.js";
import type { Scheduler } from "../src/core/ports.js";
import type { OutboundFrame } from "../src/core/protocol.js";
import { createRegistry } from "../src/core/registry.js";
import { FakeClock } from "./helpers/harness.js";

const GPU = { vendor: "x", architecture: "y", shaderF16: true, maxBufferSize: 1 };
const MODEL = { id: "qwen3.5-4b", webllmId: "Qwen3.5-4B-q4f16_1-MLC", contextWindow: 4096, priceMultiplier: 1 };

/** Timers run only when the test advances time. */
class ManualScheduler implements Scheduler {
  constructor(private readonly clock: FakeClock) {}
  private now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 0;
  after(ms: number, fn: () => void) {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return () => void this.timers.delete(id);
  }
  advance(ms: number) {
    const end = this.now + ms;
    let before = this.now;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      this.clock.advance(this.now - before);
      before = this.now;
      due[1].fn();
    }
    this.clock.advance(end - before);
    this.now = end;
  }
}

function setup() {
  const clock = new FakeClock();
  const registry = createRegistry({ clock, secrets: nodeSecrets });
  const scheduler = new ManualScheduler(clock);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const dispatcher = createDispatcher({ registry, scheduler, clock, log });
  const sent: { workerId: string; frame: OutboundFrame }[] = [];
  const dropped: { workerId: string; code: number }[] = [];
  const link: WorkerLink = {
    send(workerId, frame) {
      sent.push({ workerId, frame });
      return true;
    },
    drop(workerId, code) {
      dropped.push({ workerId, code });
    },
  };
  dispatcher.setLink(link);

  function worker(id: string, userId: string, model = MODEL) {
    registry.register(id, userId, `device-${id}`);
    registry.markReady(id, { id: model.id, webllmId: model.webllmId }, GPU);
    dispatcher.onWorkerReady(id);
  }
  /** A worker is gone: registry first (like the adapter), then the dispatcher. */
  const gone = (id: string) => {
    registry.unregister(id);
    dispatcher.onWorkerGone(id);
  };

  let n = 0;
  function job(consumerId: string, over: Partial<JobRequest> = {}) {
    const events: string[] = [];
    const chunks: string[] = [];
    let result: JobResult | undefined;
    let failure: FailCode | undefined;
    const cancelled: (CancelResult | undefined)[] = [];
    const sink: JobSink = {
      onCancelled: (r) => cancelled.push(r),
      onStart: ({ workerId }) => events.push(`start:${workerId}`),
      onChunk: (d) => chunks.push(d),
      onDone: (r) => {
        result = r;
        events.push("done");
      },
      onFail: (c) => {
        failure = c;
        events.push(`fail:${c}`);
      },
    };
    const jobId = over.jobId ?? `job-${n++}`;
    const handle = dispatcher.submit(
      {
        jobId,
        consumerId,
        lane: "fair",
        balance: 0,
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        params: { max_tokens: 100 },
        ...over,
      },
      sink,
    );
    return { jobId, handle, events, chunks, cancelled, result: () => result, failure: () => failure };
  }

  const jobFrames = (workerId?: string) =>
    sent.filter((s) => s.frame.type === "job" && (workerId === undefined || s.workerId === workerId));
  const cancels = () => sent.filter((s) => s.frame.type === "cancel");
  const done = (workerId: string, id: string, usage = { promptTokens: 5, completionTokens: 2, decodeTokensPerS: 9 }) =>
    dispatcher.onDone(workerId, { type: "done", id, finishReason: "stop", usage });
  const chunk = (workerId: string, id: string, delta = "a") =>
    dispatcher.onChunk(workerId, { type: "chunk", id, delta });
  /** One chunk of output, then `done`: a normal completion. */
  const complete = (workerId: string, id: string) => {
    chunk(workerId, id);
    done(workerId, id);
  };

  return {
    registry,
    scheduler,
    dispatcher,
    log,
    sent,
    dropped,
    worker,
    gone,
    job,
    jobFrames,
    cancels,
    done,
    chunk,
    complete,
  };
}

describe("dispatcher", () => {
  it("sends the provider only messages and whitelisted params, never the consumer", () => {
    const t = setup();
    t.worker("w1", "provider");
    const j = t.job("consumer-secret-id", { params: { max_tokens: 50, temperature: 0.5 } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.frame).toEqual({
      type: "job",
      id: j.jobId,
      messages: [{ role: "user", content: "hi" }],
      params: { max_tokens: 50, temperature: 0.5 },
    });
    expect(JSON.stringify(t.sent)).not.toContain("consumer-secret-id");
    expect(t.registry.get("w1")).toMatchObject({ state: "busy", jobId: j.jobId });
  });

  it("streams chunks, completes with the provider's ids and frees the worker for the next job", () => {
    const t = setup();
    t.worker("w1", "provider");
    const a = t.job("c1");
    const b = t.job("c2");
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(1);
    t.chunk("w1", a.jobId, "He");
    t.chunk("w1", a.jobId, "llo");
    t.done("w1", a.jobId);
    expect(a.chunks).toEqual(["He", "llo"]);
    expect(a.events).toEqual(["start:w1", "done"]);
    expect(a.result()).toMatchObject({ finishReason: "stop", providerId: "provider", workerId: "w1" });
    // The next queued job went straight out.
    expect(t.jobFrames("w1").map((s) => (s.frame as { id: string }).id)).toEqual([a.jobId, b.jobId]);
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(0);
  });

  it("fails fast with no_providers when no worker of the model is online", () => {
    const t = setup();
    const j = t.job("c1");
    expect(j.failure()).toBe("no_providers");
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(0);
  });

  it("never routes a job to its consumer's own worker", () => {
    const t = setup();
    t.worker("mine", "alice");
    const own = t.job("alice");
    expect(t.jobFrames()).toHaveLength(0);
    expect(own.events).toEqual([]);
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(1);
    // Another consumer is served by that worker even though alice is ahead in the queue.
    const other = t.job("bob");
    expect(other.events).toEqual(["start:mine"]);
    // A second worker of someone else picks up alice's job when it becomes ready.
    t.worker("theirs", "carol");
    expect(own.events).toEqual(["start:theirs"]);
  });

  it("serves the priority lane before the fair lane, FIFO inside priority", () => {
    const t = setup();
    t.worker("w1", "provider");
    const first = t.job("c0"); // takes the worker
    const fair = t.job("c1", { lane: "fair", balance: 0 });
    const p1 = t.job("c2", { lane: "priority", balance: 5 });
    const p2 = t.job("c3", { lane: "priority", balance: 500 });
    const order: string[] = [];
    for (const j of [first, p1, p2, fair]) {
      const frames = t.jobFrames();
      expect(frames.length).toBeGreaterThan(0);
      t.complete("w1", j.jobId);
      order.push(j.jobId);
    }
    expect(t.jobFrames().map((s) => (s.frame as { id: string }).id)).toEqual([
      first.jobId,
      p1.jobId,
      p2.jobId,
      fair.jobId,
    ]);
    expect(order).toHaveLength(4);
  });

  it("orders the fair lane by balance (higher first), then arrival", () => {
    const t = setup();
    t.worker("w1", "provider");
    const first = t.job("c0");
    const poor = t.job("c1", { balance: -50 });
    const zeroA = t.job("c2", { balance: 0 });
    const zeroB = t.job("c3", { balance: 0 });
    const lessPoor = t.job("c4", { balance: -5 });
    for (const j of [first, zeroA, zeroB, lessPoor, poor]) t.complete("w1", j.jobId);
    expect(t.jobFrames().map((s) => (s.frame as { id: string }).id)).toEqual([
      first.jobId,
      zeroA.jobId,
      zeroB.jobId,
      lessPoor.jobId,
      poor.jobId,
    ]);
  });

  it("requeues once at the front when the worker disappears before the first chunk", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const a = t.job("c1");
    const first = t.sent[0]!.workerId;
    const second = first === "w1" ? "w2" : "w1";
    t.gone(first);
    // The retry goes to the other worker, not back to the one that failed.
    expect(a.events).toEqual([`start:${first}`, `start:${second}`]);
    expect(a.failure()).toBeUndefined();
    t.gone(second);
    expect(a.failure()).toBe("provider_failed");
  });

  it("a requeued job goes before the others of its lane", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    const b = t.job("c2"); // queued behind a
    t.gone("w1");
    t.worker("w2", "p2");
    expect(t.jobFrames("w2").map((s) => (s.frame as { id: string }).id)).toEqual([a.jobId]);
    t.complete("w2", a.jobId);
    expect(t.jobFrames("w2").map((s) => (s.frame as { id: string }).id)).toEqual([a.jobId, b.jobId]);
  });

  it("requeues after a worker error before the first chunk; the second failure is provider_failed", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    t.dispatcher.onError("w1", { type: "error", id: a.jobId, code: "engine_error", message: "x" });
    // The worker that just failed is not asked again: the retry waits for another one.
    expect(a.events).toEqual(["start:w1"]);
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(1);
    t.worker("w2", "p2");
    expect(a.events).toEqual(["start:w1", "start:w2"]);
    t.dispatcher.onError("w2", { type: "error", id: a.jobId, code: "engine_error", message: "x" });
    expect(a.failure()).toBe("provider_failed");
    expect(t.registry.get("w1")!.state).toBe("ready");
    expect(t.registry.get("w2")!.state).toBe("ready");
  });

  it("fails with provider_failed, no retry, when the worker goes after the first chunk", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const a = t.job("c1");
    const first = t.sent[0]!.workerId;
    t.chunk(first, a.jobId);
    t.gone(first);
    expect(a.failure()).toBe("provider_failed");
    expect(t.jobFrames()).toHaveLength(1);
  });

  it("ignores frames for another job id or from a worker that holds nothing", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const a = t.job("c1");
    const holder = t.sent[0]!.workerId;
    const other = holder === "w1" ? "w2" : "w1";
    t.chunk(holder, "someone-elses-job", "x");
    t.chunk(other, a.jobId, "y");
    t.done(other, a.jobId);
    t.done(holder, "someone-elses-job");
    expect(a.chunks).toEqual([]);
    expect(a.result()).toBeUndefined();
    expect(t.registry.get(holder)!.state).toBe("busy");
  });

  it("times out 30 s without a first chunk: cancels the worker, retries elsewhere, drops it when it stays silent", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const a = t.job("c1");
    const stuck = t.sent[0]!.workerId;
    const healthy = stuck === "w1" ? "w2" : "w1";
    t.scheduler.advance(FIRST_CHUNK_TIMEOUT_MS);
    expect(t.cancels().map((c) => c.workerId)).toEqual([stuck]);
    expect(a.events).toEqual([`start:${stuck}`, `start:${healthy}`]);
    // Still busy: the cancel is not confirmed.
    expect(t.registry.get(stuck)!.state).toBe("busy");
    t.scheduler.advance(CANCEL_GRACE_MS);
    expect(t.dropped).toEqual([{ workerId: stuck, code: 4408 }]);
    expect(t.registry.get(stuck)).toBeUndefined();
  });

  it("a worker that confirms the cancel in time is freed and keeps its socket", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    t.scheduler.advance(FIRST_CHUNK_TIMEOUT_MS);
    t.dispatcher.onDone("w1", {
      type: "done",
      id: a.jobId,
      finishReason: "abort",
      usage: { promptTokens: 0, completionTokens: 0, decodeTokensPerS: 0 },
    });
    t.scheduler.advance(CANCEL_GRACE_MS * 2);
    expect(t.dropped).toEqual([]);
    // The confirmed worker took the retry.
    expect(a.events).toContain("start:w1");
  });

  it("times out a job at 180 s total: provider_failed after the first chunk", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    t.chunk("w1", a.jobId);
    t.scheduler.advance(FIRST_CHUNK_TIMEOUT_MS + 1_000); // first chunk arrived: no first-chunk timeout
    expect(a.failure()).toBeUndefined();
    t.scheduler.advance(JOB_TIMEOUT_MS);
    expect(a.failure()).toBe("provider_failed");
    expect(t.cancels()).toHaveLength(1);
    t.scheduler.advance(CANCEL_GRACE_MS);
    expect(t.dropped).toEqual([{ workerId: "w1", code: 4408 }]);
  });

  it("a queued job waits at most 30 s, then network_busy", () => {
    const t = setup();
    t.worker("w1", "p1");
    const running = t.job("c1");
    t.chunk("w1", running.jobId); // alive: no first-chunk timeout
    const waiting = t.job("c2");
    t.scheduler.advance(MAX_QUEUE_WAIT_MS - 1);
    expect(waiting.failure()).toBeUndefined();
    t.scheduler.advance(1);
    expect(waiting.failure()).toBe("network_busy");
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(0);
  });

  it("queues at most 100 per model; the 101st is network_busy at once", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.job("c0"); // runs
    for (let i = 0; i < MAX_QUEUED_PER_MODEL; i++) expect(t.job(`c${i + 1}`).failure()).toBeUndefined();
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(MAX_QUEUED_PER_MODEL);
    expect(t.job("overflow").failure()).toBe("network_busy");
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(MAX_QUEUED_PER_MODEL);
  });

  it("cancel of a queued job just removes it, without callbacks", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.job("c1");
    const waiting = t.job("c2");
    waiting.handle.cancel();
    expect(t.dispatcher.queueDepth(MODEL.webllmId)).toBe(0);
    t.scheduler.advance(MAX_QUEUE_WAIT_MS * 2);
    expect(waiting.events).toEqual([]);
  });

  it("cancel of a running job sends cancel, keeps the worker busy until it answers, then serves the next", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    const b = t.job("c2");
    t.chunk("w1", a.jobId);
    a.handle.cancel();
    expect(t.cancels()).toEqual([{ workerId: "w1", frame: { type: "cancel", id: a.jobId } }]);
    expect(t.registry.get("w1")!.state).toBe("busy");
    expect(b.events).toEqual([]);
    // Late chunks of the cancelled job reach nobody.
    t.chunk("w1", a.jobId, "late");
    expect(a.chunks).toEqual(["a"]);
    t.dispatcher.onDone("w1", {
      type: "done",
      id: a.jobId,
      finishReason: "abort",
      usage: { promptTokens: 1, completionTokens: 1, decodeTokensPerS: 1 },
    });
    expect(a.events).toEqual(["start:w1"]);
    expect(a.result()).toBeUndefined();
    // Output was delivered, so the confirmed `done` is billed, capped at the chunks that were delivered.
    expect(a.cancelled).toEqual([
      { usage: { promptTokens: 1, completionTokens: 1, decodeTokensPerS: 1 }, providerId: "p1", workerId: "w1" },
    ]);
    expect(b.events).toEqual(["start:w1"]);
    t.scheduler.advance(CANCEL_GRACE_MS * 2);
    expect(t.dropped).toEqual([]);
  });

  it("a worker that ignores a consumer cancel is dropped after the 10 s grace", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    a.handle.cancel();
    t.scheduler.advance(CANCEL_GRACE_MS - 1);
    expect(t.dropped).toEqual([]);
    expect(a.cancelled).toEqual([]);
    t.scheduler.advance(1);
    expect(t.dropped).toEqual([{ workerId: "w1", code: 4408 }]);
    expect(t.registry.get("w1")).toBeUndefined();
    expect(a.cancelled).toEqual([undefined]);
  });

  it("a consumer cancel after output is billed for the delivered chunks only, within the grace", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1", { params: { max_tokens: 100 } });
    for (let i = 0; i < 3; i++) t.chunk("w1", a.jobId);
    a.handle.cancel();
    t.chunk("w1", a.jobId, "never delivered");
    t.done("w1", a.jobId, { promptTokens: 20, completionTokens: 80, decodeTokensPerS: 4 });
    expect(a.cancelled).toEqual([
      { usage: { promptTokens: 20, completionTokens: 3, decodeTokensPerS: 4 }, providerId: "p1", workerId: "w1" },
    ]);
    expect(a.events).toEqual(["start:w1"]);
  });

  it("a consumer cancel after output with no confirmation, or an error, bills nothing", () => {
    const t = setup();
    t.worker("w1", "p1");
    const silent = t.job("c1");
    t.chunk("w1", silent.jobId);
    silent.handle.cancel();
    t.scheduler.advance(CANCEL_GRACE_MS);
    expect(silent.cancelled).toEqual([undefined]);

    t.worker("w2", "p2");
    const errored = t.job("c2");
    t.chunk("w2", errored.jobId);
    errored.handle.cancel();
    t.dispatcher.onError("w2", { type: "error", id: errored.jobId, code: "x", message: "x" });
    expect(errored.cancelled).toEqual([undefined]);
  });

  it("a consumer cancel before any output bills nothing, queued or running", () => {
    const t = setup();
    t.worker("w1", "p1");
    const running = t.job("c1");
    const queued = t.job("c2");
    queued.handle.cancel();
    expect(queued.cancelled).toEqual([undefined]);
    running.handle.cancel();
    t.dispatcher.onDone("w1", {
      type: "done",
      id: running.jobId,
      finishReason: "abort",
      usage: { promptTokens: 9, completionTokens: 9, decodeTokensPerS: 1 },
    });
    expect(running.cancelled).toEqual([undefined]);
  });

  it("a done with no output, or only whitespace, is a worker failure and follows the requeue rules", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const empty = t.job("c1");
    const first = t.sent[0]!.workerId;
    t.done(first, empty.jobId);
    expect(empty.result()).toBeUndefined();
    expect(empty.events).toEqual([`start:${first}`, `start:${first === "w1" ? "w2" : "w1"}`]);
    const second = first === "w1" ? "w2" : "w1";
    t.done(second, empty.jobId);
    expect(empty.failure()).toBe("provider_failed");

    const blank = t.job("c2");
    const holder = t.sent.at(-1)!.workerId;
    t.chunk(holder, blank.jobId, " \n ");
    t.done(holder, blank.jobId);
    expect(blank.result()).toBeUndefined();
    expect(blank.failure()).toBe("provider_failed"); // output had started: no retry
  });

  it("caps the reported prompt tokens by the size of the messages", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1", { messages: [{ role: "user", content: "hi" }] });
    t.chunk("w1", a.jobId);
    t.done("w1", a.jobId, { promptTokens: 4000, completionTokens: 1, decodeTokensPerS: 1 });
    // 2 bytes + 16 per message + 32.
    expect(a.result()!.usage.promptTokens).toBe(50);
    const b = t.job("c2", { messages: [{ role: "user", content: "é".repeat(100) }] });
    t.chunk("w1", b.jobId);
    t.done("w1", b.jobId, { promptTokens: 4000, completionTokens: 1, decodeTokensPerS: 1 });
    expect(b.result()!.usage.promptTokens).toBe(200 + 16 + 32);
  });

  it("the 30 s queue budget covers all attempts of a job, not each one", () => {
    const t = setup();
    t.worker("w1", "p1");
    const running = t.job("c0");
    const a = t.job("c1");
    t.chunk("w1", running.jobId);
    t.scheduler.advance(20_000);
    t.done("w1", running.jobId);
    expect(a.events).toEqual(["start:w1"]); // waited 20 s
    t.dispatcher.onError("w1", { type: "error", id: a.jobId, code: "x", message: "x" });
    // No other worker: the retry has only the 10 s that are left.
    t.scheduler.advance(9_999);
    expect(a.failure()).toBeUndefined();
    t.scheduler.advance(1);
    expect(a.failure()).toBe("network_busy");
  });

  it("a worker whose socket throws is treated like a failed send", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    const seen: string[] = [];
    t.dispatcher.setLink({
      send(workerId) {
        seen.push(workerId);
        if (seen.length === 1) throw new Error("socket exploded");
        return true;
      },
      drop: (workerId, code) => t.dropped.push({ workerId, code }),
    });
    const a = t.job("c1");
    expect(a.events).toEqual([`start:${seen[0]}`, `start:${seen[1]}`]);
    expect(seen[1]).not.toBe(seen[0]);
    expect(t.dropped.map((d) => d.workerId)).toEqual([seen[0]]);
  });

  it("caps reported usage at max_tokens, chunks received and the context window", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1", { params: { max_tokens: 5 }, messages: [{ role: "user", content: "x".repeat(10_000) }] });
    for (let i = 0; i < 4; i++) t.chunk("w1", a.jobId);
    t.done("w1", a.jobId, { promptTokens: 999_999, completionTokens: 1_000, decodeTokensPerS: 7 });
    expect(a.result()!.usage).toEqual({ promptTokens: 4096, completionTokens: 4, decodeTokensPerS: 7 });
    expect(t.log.warn).toHaveBeenCalledWith("usage_capped", expect.objectContaining({ job_id: a.jobId }));

    const b = t.job("c2", { params: { max_tokens: 3 } });
    for (let i = 0; i < 3; i++) t.chunk("w1", b.jobId);
    t.done("w1", b.jobId, { promptTokens: 10, completionTokens: 50, decodeTokensPerS: 1 });
    expect(b.result()!.usage.completionTokens).toBe(3);
  });

  it("honest usage is not touched and not logged", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1");
    t.chunk("w1", a.jobId);
    t.chunk("w1", a.jobId);
    t.done("w1", a.jobId, { promptTokens: 7, completionTokens: 2, decodeTokensPerS: 3 });
    expect(a.result()!.usage).toEqual({ promptTokens: 7, completionTokens: 2, decodeTokensPerS: 3 });
    expect(t.log.warn).not.toHaveBeenCalled();
  });

  it("cuts off a provider that streams far more than max_tokens", () => {
    const t = setup();
    t.worker("w1", "p1");
    const a = t.job("c1", { params: { max_tokens: 2 } });
    for (let i = 0; i < 20; i++) t.chunk("w1", a.jobId);
    expect(a.failure()).toBe("provider_failed");
    expect(t.cancels()).toHaveLength(1);
  });

  it("a worker becoming ready serves a waiting job", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.job("c1");
    const waiting = t.job("c2");
    t.worker("w2", "p2");
    expect(waiting.events).toEqual(["start:w2"]);
  });

  it("a failed send drops the worker and retries the job", () => {
    const t = setup();
    t.worker("w1", "p1");
    t.worker("w2", "p2");
    let failFirst = true;
    const original = t.sent;
    let failed = "";
    t.dispatcher.setLink({
      send(workerId, frame) {
        if (failFirst) {
          failFirst = false;
          failed = workerId;
          return false;
        }
        original.push({ workerId, frame });
        return true;
      },
      drop: (workerId, code) => t.dropped.push({ workerId, code }),
    });
    const a = t.job("c1");
    expect(t.dropped).toHaveLength(1);
    // The retry went to the other worker.
    expect(a.events).toEqual([`start:${failed}`, `start:${failed === "w1" ? "w2" : "w1"}`]);
    expect(original.map((f) => f.workerId)).toEqual([failed === "w1" ? "w2" : "w1"]);
    expect(a.failure()).toBeUndefined();
  });
});
