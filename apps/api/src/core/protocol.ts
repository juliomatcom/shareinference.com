import { z } from "zod";

// Provider WebSocket protocol v1 (wiki-llm/worker-protocol.md). The provider browser is untrusted: every inbound
// frame is parsed here, with a bound on every string and number.
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;

/** WebSocket close codes the api uses. */
export const CLOSE = {
  badFrame: 4400,
  unauthorized: 4401,
  /** The owner was suspended; found at the once-a-minute heartbeat check. */
  suspended: 4403,
  unknownModel: 4404,
  timeout: 4408,
  replaced: 4409,
  /** Too many unprocessed bytes queued on one socket; retryable, unlike a protocol error. */
  backlog: 4413,
  tooMany: 4429,
} as const;

const id = z.string().min(1).max(64);
const count = z.number().int().min(0).max(1_000_000_000);
/** Running totals (stats frames) outgrow `count` over time. */
const total = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().max(max);

export const gpuSchema = z
  .object({
    vendor: text(64),
    architecture: text(64),
    shaderF16: z.boolean(),
    maxBufferSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type Gpu = z.infer<typeof gpuSchema>;

// Worker -> server.
export const authFrame = z
  .object({
    type: z.literal("auth"),
    token: z.string().min(1).max(128),
    protocol: z.literal(PROTOCOL_VERSION),
    deviceKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export const readyFrame = z
  .object({
    type: z.literal("ready"),
    model: text(128).min(1),
    gpu: gpuSchema,
    loadMs: z.number().int().min(0).max(3_600_000),
    /** Context window the worker loaded (tokens). Omitted by older tabs, which always ran WebLLM's 4096. */
    contextWindow: z.number().int().min(256).max(1_048_576).optional(),
  })
  .strict();
export const heartbeatFrame = z.object({ type: z.literal("heartbeat") }).strict();
export const chunkFrame = z.object({ type: z.literal("chunk"), id, delta: text(16_384) }).strict();
export const doneFrame = z
  .object({
    type: z.literal("done"),
    id,
    finishReason: z.enum(["stop", "length", "abort"]),
    usage: z
      .object({ promptTokens: count, completionTokens: count, decodeTokensPerS: z.number().min(0).max(100_000) })
      .strict(),
  })
  .strict();
export const errorFrame = z
  .object({ type: z.literal("error"), id, code: text(64).min(1), message: text(500) })
  .strict();

export const inboundFrame = z.discriminatedUnion("type", [
  authFrame,
  readyFrame,
  heartbeatFrame,
  chunkFrame,
  doneFrame,
  errorFrame,
]);
export type InboundFrame = z.infer<typeof inboundFrame>;
export type AuthFrame = z.infer<typeof authFrame>;
export type ReadyFrame = z.infer<typeof readyFrame>;

// Server -> worker.
export const jobParams = z
  .object({
    temperature: z.number(),
    top_p: z.number(),
    max_tokens: z.number().int(),
    stop: z.array(z.string()),
    presence_penalty: z.number(),
    frequency_penalty: z.number(),
    seed: z.number().int(),
    enable_thinking: z.boolean(),
  })
  .partial()
  .strict();

export const outboundFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), workerId: z.string() }).strict(),
  /** The answer to every `heartbeat`: lets the worker tell a live socket from a half-open one. */
  z.object({ type: z.literal("pong") }).strict(),
  z
    .object({
      type: z.literal("job"),
      id,
      messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }).strict()),
      params: jobParams,
    })
    .strict(),
  z.object({ type: z.literal("cancel"), id }).strict(),
  z
    .object({
      type: z.literal("stats"),
      jobsServed: total,
      promptTokens: total,
      completionTokens: total,
      creditsEarned: total,
      lastJob: z
        .object({ promptTokens: count, completionTokens: count, decodeTokensPerS: z.number(), credits: total })
        .strict()
        .nullable(),
    })
    .strict(),
]);
export type OutboundFrame = z.infer<typeof outboundFrame>;
