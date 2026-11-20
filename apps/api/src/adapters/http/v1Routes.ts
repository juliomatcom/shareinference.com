import type { Express, RequestHandler, Response } from "express";
import type { Deps } from "../../core/deps.js";
import { chatRequest, type ChatRequest } from "../../core/chat.js";
import type { FailCode } from "../../core/dispatcher.js";
import { onlineModels, startChat, type ChatSink } from "../../core/inference.js";
import { createThinkSplitter } from "../../core/thinking.js";
import type { JobSource } from "../../core/types.js";
import { apiError } from "./errors.js";
import { principalOf, userOf } from "./principal.js";

/** `created` of a catalog model: the catalog has no timestamp, so a fixed one (clients only display it). */
const MODELS_CREATED = 1_767_225_600;

const FAILURES: Record<FailCode, { status: number; message: string }> = {
  provider_failed: { status: 502, message: "The provider failed while serving the request; try again" },
  network_busy: { status: 503, message: "The network is busy; try again shortly" },
  no_providers: { status: 503, message: "No provider is serving this model right now" },
};

/** The API-key routes (`/v1/*`, a session is not accepted) and the session-only Playground chat route. */
export function v1Routes(app: Express, opts: { core: Deps; requireSession: RequestHandler }): void {
  const { core, requireSession } = opts;

  const requireApiKey: RequestHandler = (_req, res, next) => {
    if (principalOf(res).via !== "apiKey") {
      res.status(401).json(apiError(401, "An API key is required", "unauthorized"));
      return;
    }
    next();
  };

  app.get("/v1/models", requireApiKey, async (_req, res) => {
    const models = await onlineModels(core);
    res.json({
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: MODELS_CREATED, owned_by: "shareinference" })),
    });
  });

  /** One handler for both doors; only the credential check in front of it and the job's `source` differ. */
  const chat =
    (source: JobSource): RequestHandler =>
    async (req, res) => {
      const parsed = chatRequest.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        // Zod messages describe the shape, never the submitted values.
        return res
          .status(400)
          .json(apiError(400, `Invalid request: ${where}${issue?.message ?? "bad body"}`, "invalid_request"));
      }
      const body = parsed.data;
      const sinkFor = (jobId: string) => (body.stream ? streamSink(res, body, jobId) : jsonSink(res, body, jobId));

      // The client may leave while admission or the queue is still running; `close` also fires after a normal end.
      let cancel: (() => void) | undefined;
      let gone = false;
      res.on("close", () => {
        if (res.writableEnded) return;
        gone = true;
        cancel?.();
      });

      const started = await startChat(core, userOf(res), source, body, sinkFor);
      if (!started.ok) return res.status(started.status).json(apiError(started.status, started.message, started.code));
      cancel = started.cancel;
      if (gone) cancel();
    };

  app.post("/v1/chat/completions", requireApiKey, chat("api"));
  // The Playground: the signed-in browser's door to the same code (the session is CSRF-checked in app.ts).
  app.post("/playground/chat/completions", requireSession, chat("playground"));
}

const failureBody = (code: FailCode) => apiError(FAILURES[code].status, FAILURES[code].message, code);

function failJson(res: Response, code: FailCode): void {
  if (res.headersSent || res.writableEnded) return;
  if (code === "network_busy") res.set("Retry-After", "5");
  res.status(FAILURES[code].status).json(failureBody(code));
}

const usageOf = (u: { promptTokens: number; completionTokens: number }) => ({
  prompt_tokens: u.promptTokens,
  completion_tokens: u.completionTokens,
  total_tokens: u.promptTokens + u.completionTokens,
});

/** Non-stream: buffers the output, then answers with one `chat.completion`. */
function jsonSink(res: Response, body: ChatRequest, jobId: string): ChatSink {
  const splitter = createThinkSplitter();
  let content = "";
  let reasoning = "";
  const take = (s: { content: string; reasoning: string }) => {
    content += s.content;
    reasoning += s.reasoning;
  };
  return {
    onChunk: (delta) => take(splitter.push(delta)),
    onDone({ finishReason, usage }) {
      take(splitter.end());
      if (res.headersSent || res.writableEnded) return;
      res.json({
        id: `chatcmpl-${jobId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content, ...(reasoning !== "" && { reasoning_content: reasoning }) },
            finish_reason: finishReason,
          },
        ],
        usage: usageOf(usage),
      });
    },
    onFail: (code) => failJson(res, code),
  };
}

/**
 * Stream: SSE headers go out with the first provider chunk, so a failure before it is still a normal JSON error; after
 * it, an `error` event ends the stream.
 */
function streamSink(res: Response, body: ChatRequest, jobId: string): ChatSink {
  const splitter = createThinkSplitter();
  const id = `chatcmpl-${jobId}`;
  const created = Math.floor(Date.now() / 1000);
  let open = false;
  const write = (data: unknown) => {
    if (!res.writableEnded && !res.destroyed)
      res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  };
  const chunk = (delta: Record<string, string>, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const begin = () => {
    if (open) return;
    open = true;
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    write(chunk({ role: "assistant", content: "" }));
  };
  const emit = (s: { content: string; reasoning: string }) => {
    if (s.reasoning !== "") write(chunk({ reasoning_content: s.reasoning }));
    if (s.content !== "") write(chunk({ content: s.content }));
  };
  return {
    onChunk(delta) {
      begin();
      emit(splitter.push(delta));
    },
    onDone({ finishReason, usage }) {
      begin();
      emit(splitter.end());
      write(chunk({}, finishReason));
      if (body.stream_options?.include_usage) {
        write({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usageOf(usage) });
      }
      write("[DONE]");
      res.end();
    },
    onFail(code) {
      if (!open) return failJson(res, code);
      write(failureBody(code));
      res.end();
    },
  };
}
