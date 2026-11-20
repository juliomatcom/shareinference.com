import { z } from "zod";
import type { JobRequest } from "./dispatcher.js";

export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_MAX_TOKENS = 2048;

// Exactly the fields wiki-llm/api.md accepts; anything else is a 400. Clients often send `null` for "unset".
const message = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }).strict();

export const chatRequest = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(message).min(1).max(256),
    stream: z.boolean().nullish(),
    stream_options: z.object({ include_usage: z.boolean().nullish() }).strict().nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    max_tokens: z.number().int().min(1).max(MAX_MAX_TOKENS).nullish(),
    stop: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(4)]).nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),
    seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullish(),
    enable_thinking: z.boolean().nullish(),
    chat_template_kwargs: z.object({ enable_thinking: z.boolean().nullish() }).strict().nullish(),
  })
  .strict();
export type ChatRequest = z.infer<typeof chatRequest>;

/** The whitelisted generation params handed to a provider (nothing else of the request goes along). */
export function jobParams(body: ChatRequest): JobRequest["params"] {
  const stop = body.stop == null ? undefined : Array.isArray(body.stop) ? body.stop : [body.stop];
  const thinking = body.enable_thinking ?? body.chat_template_kwargs?.enable_thinking;
  const params: JobRequest["params"] = { max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS };
  if (body.temperature != null) params.temperature = body.temperature;
  if (body.top_p != null) params.top_p = body.top_p;
  if (stop && stop.length > 0) params.stop = stop;
  if (body.presence_penalty != null) params.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty != null) params.frequency_penalty = body.frequency_penalty;
  if (body.seed != null) params.seed = body.seed;
  if (thinking != null) params.enable_thinking = thinking;
  return params;
}

/**
 * A rough token count of the prompt: about 4 ASCII characters per token, and every other code point as a token of its
 * own (a safe over-estimate for CJK and emoji). Only used to refuse requests that cannot fit the context window.
 */
export function promptTokenEstimate(body: ChatRequest): number {
  let ascii = 0;
  let other = 0;
  for (const m of body.messages) {
    for (const ch of m.content) {
      if (ch.charCodeAt(0) < 128) ascii++;
      else other++;
    }
  }
  return Math.ceil(ascii / 4) + other;
}
