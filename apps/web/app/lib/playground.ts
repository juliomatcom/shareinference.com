// Client of `POST /api/playground/chat/completions` (wiki-llm/web.md): streams one reply and measures it. Text is only
// ever handed back as strings for plain-text rendering.
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamResult {
  usage: Usage | null;
  finishReason: string | null;
}

/** Tokens reserved for a reply: sent as `max_tokens` (the api default) and counted in the context meter. */
const MAX_TOKENS = 4096;
// Inkling decodes at about 17 tok/s: 4096 tokens would need ~241 s plus prefill, close to the 300 s Playground job timeout
// (a timeout moves no credits, D43), so its reply is capped lower. A Map: model ids come from the api.
const MAX_TOKENS_BY_MODEL = new Map([["inkling-2-mini", 2048]]);
// Models whose chat template cannot switch reasoning off (the model card says so): the Playground hides its Thinking
// switch for them. They are sent `enable_thinking: false`, which the engine maps to the shortest reasoning effort.
const ALWAYS_THINKS = new Set(["inkling-2-mini"]);
export const alwaysThinks = (modelId: string): boolean => ALWAYS_THINKS.has(modelId);
export const maxTokensFor = (modelId: string): number => MAX_TOKENS_BY_MODEL.get(modelId) ?? MAX_TOKENS;

export class ChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface WireChunk {
  error?: { code?: string; message?: string };
  choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export async function streamChat(
  req: { model: string; messages: ChatMessage[]; enableThinking: boolean },
  signal: AbortSignal,
  onDelta: (delta: { content: string; reasoning: string }) => void,
): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch("/api/playground/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokensFor(req.model),
        enable_thinking: req.enableThinking,
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatError(0, "network", "Could not reach the server");
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as WireChunk | null;
    throw new ChatError(res.status, json?.error?.code ?? "error", json?.error?.message ?? "Request failed");
  }
  if (!res.body) throw new ChatError(0, "network", "The server sent no stream");

  const result: StreamResult = { usage: null, finishReason: null };
  const handle = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(payload) as WireChunk;
    } catch {
      return false;
    }
    if (chunk.error) throw new ChatError(502, chunk.error.code ?? "error", chunk.error.message ?? "The reply failed");
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content ?? "";
    const reasoning = choice?.delta?.reasoning_content ?? "";
    if (content !== "" || reasoning !== "") onDelta({ content, reasoning });
    if (choice?.finish_reason) result.finishReason = choice.finish_reason;
    if (chunk.usage) {
      result.usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
    return false;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // A read can end in the middle of a line: keep the unfinished tail for the next read.
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    tail += decoder.decode(value, { stream: !done });
    const lines = tail.split("\n");
    tail = done ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      if (handle(line.slice(5).trim())) return result;
    }
    if (done) break;
  }
  // The stream ended without [DONE]: the api always sends it after a complete reply.
  throw new ChatError(0, "interrupted", "The reply was cut off");
}

/**
 * The api's prompt estimate (`promptTokenEstimate` in apps/api/src/core/chat.ts): about 4 ASCII characters per token and
 * one token per other code point. The server refuses a request when estimate + max_tokens exceeds the context window.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let ascii = 0;
  let other = 0;
  for (const m of messages) {
    for (const ch of m.content) {
      if (ch.charCodeAt(0) < 128) ascii++;
      else other++;
    }
  }
  return Math.ceil(ascii / 4) + other;
}

/** The api accepts at most 256 messages per request. */
export const MAX_MESSAGES = 256;

const fmt = (n: number) => n.toLocaleString("en-US");

/** Text for a request that cannot fit the model: a fresh chat only needs a shorter message. */
export function tooLongText(contextWindow: number, fresh: boolean): string {
  return fresh
    ? "This message is too long for the model. Shorten it and try again."
    : `This conversation is too long for the model's memory (about ${fmt(contextWindow)} tokens, including the reply). Start a new chat to keep going.`;
}

export interface Friendly {
  text: string;
  /** Show a "New chat" button next to the text. */
  newChat: boolean;
}

/** Friendly text for a failed call; never an api or HTTP detail. */
export function friendlyError(error: ChatError, ctx: { contextWindow: number; fresh: boolean }): Friendly {
  const plain = (text: string): Friendly => ({ text, newChat: false });
  // Too long: the context check (400), the message-count limit (400 on `messages`) and a body over the size limit (413).
  if (
    error.status === 413 ||
    (error.status === 400 &&
      (/context length/i.test(error.message) || /^Invalid request: messages/.test(error.message)))
  ) {
    return { text: tooLongText(ctx.contextWindow, ctx.fresh), newChat: !ctx.fresh };
  }
  switch (error.code) {
    case "rate_limited":
      return plain("You are sending requests too fast. Wait a moment and try again.");
    case "network_busy":
      return plain("The network is busy. Try again in a few seconds.");
    case "no_providers":
      // The api words this one (it also says when only your own GPU is online).
      return plain(error.message || "No provider is serving this model right now. Try again later.");
    case "account_too_new":
      return plain(
        "Your GitHub account is too new for the fair queue. Earn credits by sharing your GPU, or try again once your account is 30 days old.",
      );
    case "provider_failed":
      return plain("The provider failed while answering. Try again.");
    case "unauthorized":
      return plain("Your session ended. Reload the page to sign in again.");
    case "csrf":
      return plain("The request was rejected. Reload the page and try again.");
    case "network":
    case "interrupted":
      return plain(error.message);
    default:
      return plain("Something went wrong. Try again.");
  }
}
