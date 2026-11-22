"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRequireMe } from "../components/MeProvider";
import { gateMessage, input, primaryButton } from "../components/ui";
import { creditsFor, formatNumber, pickDefaultModel, type PublicModel } from "../lib/api";
import { ModelScores } from "../components/ModelScores";
import {
  ChatError,
  MAX_MESSAGES,
  estimateTokens,
  friendlyError,
  alwaysThinks,
  maxTokensFor,
  streamChat,
  tooLongText,
  type ChatMessage,
  type Friendly,
} from "../lib/playground";
import { usePolled } from "../lib/usePolled";

// What a reply cost, measured here with performance.now(). Nothing about the provider is ever shown.
interface Metrics {
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  durationMs: number;
  tokensPerS: number | null;
  finishReason: string | null;
  credits: number;
  /** True when the api sent no usage (a stopped reply): tokens are estimated from what was received. */
  estimated: boolean;
}

interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  state: "streaming" | "done" | "stopped" | "error";
  error?: string;
  metrics?: Metrics;
}

const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${formatNumber(Math.round(ms))} ms`);
/** Clicks on Stop this soon after Send are the tail of a double-click on Send, not a decision to stop. */
const STOP_GUARD_MS = 400;
const WARN_AT = 0.8;
const MAX_DRAFT_CHARS = 40_000;
/** What the Thinking switch does; shown as the tooltip on the switch and on a reply's "Thinking" disclosure. */
const THINKING_HELP =
  "Lets the model reason step by step before it answers. The reasoning is shown in a collapsible Thinking section above the reply. Answers can be better on hard questions but take longer, and the reasoning tokens are billed like reply tokens.";

const btn =
  "rounded-md border border-neutral-700 px-3 py-2 text-sm hover:border-neutral-500 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export default function Playground() {
  const { state } = useRequireMe();
  const models = usePolled<{ models: PublicModel[] }>("/public/models", 10_000);
  const online = useMemo(() => (models.data?.models ?? []).filter((m) => m.workersOnline > 0), [models.data]);
  const [selected, setSelected] = useState("");
  const model = online.find((m) => m.id === selected) ?? pickDefaultModel(online);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  // An error that is not part of the conversation (the failed message is taken back into the textarea).
  const [notice, setNotice] = useState<Friendly | null>(null);
  // The finished reply, read out once by the polite live region (never token by token).
  const [announce, setAnnounce] = useState("");
  const abort = useRef<AbortController | null>(null);
  const sentAt = useRef(0);
  // Bumped by New chat: a request that outlives it must not touch the new conversation.
  const epoch = useRef(0);
  const nextId = useRef(1);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patch = (id: number, fn: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));

  // What would be sent: answered text only. A reply that failed is never sent back as history.
  const sendable: ChatMessage[] = messages
    .filter((m) => m.content !== "" && m.state !== "error")
    .map((m) => ({ role: m.role, content: m.content }));
  const text = draft.trim();
  const next: ChatMessage[] = text ? [...sendable, { role: "user", content: text }] : sendable;
  const contextWindow = model?.contextWindow ?? 0;
  const reserved = model ? maxTokensFor(model.id) : 0; // the reply budget this model is sent with
  const used = estimateTokens(next) + reserved;
  const tooLong = model !== undefined && (used > contextWindow || next.length > MAX_MESSAGES);
  const fresh = sendable.length === 0;

  async function send() {
    if (!text || busy || !model || tooLong) return;
    const myEpoch = epoch.current;
    const alive = () => epoch.current === myEpoch;
    const user: Msg = { id: nextId.current++, role: "user", content: text, reasoning: "", state: "done" };
    const reply: Msg = { id: nextId.current++, role: "assistant", content: "", reasoning: "", state: "streaming" };
    const history = next;
    const promptEstimate = estimateTokens(history);
    setMessages((all) => [...all, user, reply]);
    setDraft("");
    setAnnounce("");
    setNotice(null);
    setBusy(true);
    stick.current = true;
    const controller = new AbortController();
    abort.current = controller;
    const started = performance.now();
    sentAt.current = started;
    let answer = "";
    let chunks = 0;
    let firstAt: number | null = null;
    let lastAt = started;
    // Speed excludes the wait: tokens after the first over the time between the first and the last chunk.
    const speed = (completion: number) =>
      firstAt !== null && chunks >= 2 && lastAt > firstAt ? (completion - 1) / ((lastAt - firstAt) / 1000) : null;
    // A failed or empty send leaves no trace: both bubbles go and the text returns to the textarea.
    const takeBack = (why: Friendly) => {
      setMessages((all) => all.filter((m) => m.id !== user.id && m.id !== reply.id));
      setDraft((d) => (d === "" ? text : d));
      setNotice(why);
    };
    try {
      const result = await streamChat(
        { model: model.id, messages: history, enableThinking: thinking && !alwaysThinks(model.id) },
        controller.signal,
        (d) => {
          const now = performance.now();
          firstAt ??= now;
          lastAt = now;
          chunks++;
          answer += d.content;
          if (alive()) {
            patch(reply.id, (m) => ({ ...m, content: m.content + d.content, reasoning: m.reasoning + d.reasoning }));
          }
        },
      );
      if (!alive()) return;
      const ended = performance.now();
      const prompt = result.usage?.promptTokens ?? promptEstimate;
      const completion = result.usage?.completionTokens ?? chunks;
      const metrics: Metrics = {
        promptTokens: prompt,
        completionTokens: completion,
        ttftMs: (firstAt ?? ended) - started,
        durationMs: ended - started,
        tokensPerS: speed(completion),
        finishReason: result.finishReason,
        credits: creditsFor(prompt, completion, model.priceMultiplier),
        estimated: result.usage === null,
      };
      patch(reply.id, (m) => ({ ...m, state: "done", metrics }));
      setAnnounce(answer || "The reply is empty.");
    } catch (error) {
      if (!alive()) return;
      if (controller.signal.aborted) {
        if (chunks === 0) {
          takeBack({ text: "Stopped before any output. Nothing was charged.", newChat: false });
        } else {
          // The api bills what was received once the provider confirms; this is only our estimate of it.
          const ended = performance.now();
          const completion = chunks;
          const metrics: Metrics = {
            promptTokens: promptEstimate,
            completionTokens: completion,
            ttftMs: (firstAt ?? ended) - started,
            durationMs: ended - started,
            tokensPerS: speed(completion),
            finishReason: null,
            credits: creditsFor(promptEstimate, completion, model.priceMultiplier),
            estimated: true,
          };
          patch(reply.id, (m) => ({ ...m, state: "stopped", metrics }));
        }
      } else {
        const why =
          error instanceof ChatError
            ? friendlyError(error, { contextWindow, fresh })
            : { text: "The connection was interrupted. Try again.", newChat: false };
        if (chunks === 0) takeBack(why);
        else patch(reply.id, (m) => ({ ...m, state: "error", error: why.text }));
        setAnnounce(why.text);
      }
    } finally {
      if (alive()) {
        setBusy(false);
        abort.current = null;
      }
    }
  }

  function stop() {
    if (performance.now() - sentAt.current < STOP_GUARD_MS) return;
    abort.current?.abort();
  }

  function newChat() {
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setMessages([]);
    setAnnounce("");
    setNotice(null);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter that confirms an IME composition (keyCode 229 on some browsers) must not send.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send();
    }
  }

  const gate = gateMessage(state);
  if (gate) return gate;

  const totals = messages.reduce(
    (t, m) =>
      m.metrics
        ? {
            replies: t.replies + 1,
            tokens: t.tokens + m.metrics.promptTokens + m.metrics.completionTokens,
            credits: t.credits + m.metrics.credits,
          }
        : t,
    { replies: 0, tokens: 0, credits: 0 },
  );
  const share = contextWindow > 0 ? Math.min(used / contextWindow, 1) : 0;
  const noModels = models.data !== null && online.length === 0;

  return (
    <main data-fill-viewport className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold">Playground</h1>
        {online.length > 0 && (
          <div>
            <label htmlFor="model" className="mb-1 block text-xs text-neutral-400">
              Model
            </label>
            <select
              id="model"
              value={model?.id ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              className={`${input} w-auto`}
            >
              {online.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
        )}
        {!(model && alwaysThinks(model.id)) && (
          <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300" title={THINKING_HELP}>
            <input
              type="checkbox"
              checked={thinking}
              onChange={(e) => setThinking(e.target.checked)}
              className="size-4 accent-accent"
            />
            Thinking
            <span
              aria-hidden="true"
              className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-neutral-600 text-[10px] text-neutral-400"
            >
              ?
            </span>
            <span className="sr-only">{THINKING_HELP}</span>
          </label>
        )}
        <button type="button" onClick={newChat} disabled={messages.length === 0} className={btn}>
          New chat
        </button>
      </div>
      {model && <ModelScores modelId={model.id} className="-mt-1" />}

      {models.failed && models.data === null ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900/60 p-6 text-center">
          <p role="status" className="text-neutral-300">
            Could not load models. Retrying...
          </p>
        </div>
      ) : noModels ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-6 text-center">
          <p role="status" className="text-neutral-200">
            No providers online right now
          </p>
          <p className="text-sm text-neutral-400">This page checks again every 10 seconds.</p>
          <Link href="/share" className={primaryButton}>
            Share your GPU
          </Link>
        </div>
      ) : (
        <>
          <div
            ref={list}
            role="region"
            aria-label="Conversation"
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="flex min-h-24 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/40 p-3"
          >
            {messages.length === 0 && <p className="m-auto text-center text-sm text-neutral-400">Ask anything.</p>}
            {messages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
          </div>
          <div aria-live="polite" className="sr-only">
            {announce}
          </div>
          {totals.replies > 0 && (
            <p className="text-xs text-neutral-400">
              This chat: {formatNumber(totals.replies)} {totals.replies === 1 ? "reply" : "replies"}, ~
              {formatNumber(totals.tokens)} tokens, ~{formatNumber(totals.credits)} credits
            </p>
          )}
          {notice && (
            <p role="alert" className="text-sm text-red-400">
              {notice.text}{" "}
              {notice.newChat && (
                <button type="button" onClick={newChat} className={`${btn} ml-1 py-1`}>
                  New chat
                </button>
              )}
            </p>
          )}
          {model && (
            <div className="text-xs text-neutral-400">
              <div className="flex items-center gap-2">
                <div aria-hidden="true" className="h-1.5 w-24 shrink-0 overflow-hidden rounded bg-neutral-800">
                  <div
                    className={`h-full ${tooLong ? "bg-red-500" : share >= WARN_AT ? "bg-amber-400" : "bg-accent"}`}
                    style={{ width: `${Math.round(share * 100)}%` }}
                  />
                </div>
                <span>
                  Context: ~{formatNumber(used)} of {formatNumber(contextWindow)} tokens (includes{" "}
                  {formatNumber(reserved)} reserved for the reply)
                </span>
              </div>
              {tooLong ? (
                <p role="alert" className="mt-1 text-red-400">
                  {tooLongText(contextWindow, fresh)}{" "}
                  {!fresh && (
                    <button type="button" onClick={newChat} className={`${btn} ml-1 py-1`}>
                      New chat
                    </button>
                  )}
                </p>
              ) : (
                share >= WARN_AT && (
                  <p className="mt-1 text-amber-400">
                    This conversation is getting long. Start a new chat soon to keep answers coming.
                  </p>
                )
              )}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-center gap-2"
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="message" className="sr-only">
                Message
              </label>
              <textarea
                id="message"
                rows={2}
                value={draft}
                maxLength={MAX_DRAFT_CHARS}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!model}
                placeholder="Message (Enter to send, Shift+Enter for a new line)"
                className={`${input} block resize-none`}
              />
            </div>
            {busy && (
              <button type="button" onClick={stop} className={btn}>
                Stop
              </button>
            )}
            <button type="submit" disabled={busy || !model || text === "" || tooLong} className={primaryButton}>
              Send
            </button>
          </form>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-neutral-500">
            <li>
              Credits shown are an estimate. The exact amounts are in your Ledger on the{" "}
              <Link href="/dashboard" className="">
                dashboard
              </Link>
              . A stopped reply is still charged for what was received.
            </li>
            <li>This chat lives only in this tab and is gone when you reload.</li>
            <li>
              The model&apos;s context window (
              {contextWindow > 0 ? `~${formatNumber(contextWindow)} tokens` : "limited"}) limits how long a conversation
              can get.
            </li>
            <li>
              Your prompts are processed in a contributor&apos;s browser.{" "}
              <Link href="/docs/privacy" className="">
                Privacy
              </Link>
            </li>
          </ul>
        </>
      )}
    </main>
  );
}

function Bubble({ m }: { m: Msg }) {
  const mine = m.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap ${
          mine ? "bg-accent/15 text-neutral-100" : "bg-neutral-800 text-neutral-100"
        }`}
      >
        {m.reasoning !== "" && (
          <details className="mb-2 text-neutral-400">
            <summary className="cursor-pointer text-xs" title={THINKING_HELP}>
              Thinking
            </summary>
            <p className="mt-1 break-words whitespace-pre-wrap">{m.reasoning}</p>
          </details>
        )}
        {m.content}
        {m.state === "streaming" && m.content === "" && m.reasoning === "" && (
          <span className="text-neutral-400">Waiting for a provider...</span>
        )}
      </div>
      {m.state === "stopped" && (
        <p className="text-xs text-neutral-400">Stopped. Partial reply, charged on the server for what was received.</p>
      )}
      {m.state === "error" && (
        <p role="alert" className="max-w-[90%] text-sm text-red-400">
          {m.error}
        </p>
      )}
      {m.metrics && <MetricsLine k={m.metrics} />}
    </div>
  );
}

function MetricsLine({ k }: { k: Metrics }) {
  const approx = k.estimated ? "~" : "";
  const items: [string, string][] = [
    ["Prompt", `${approx}${formatNumber(k.promptTokens)} tok`],
    ["Completion", `${approx}${formatNumber(k.completionTokens)} tok`],
    ["Total", `${approx}${formatNumber(k.promptTokens + k.completionTokens)} tok`],
    ["First token (queue + routing)", fmtMs(k.ttftMs)],
    ["Duration", fmtMs(k.durationMs)],
    ["Speed", k.tokensPerS === null ? "-" : `${k.tokensPerS.toFixed(1)} tok/s`],
    ["Finish", k.finishReason ?? "-"],
    ["Credits", `~${formatNumber(k.credits)}`],
  ];
  return (
    <dl className="flex max-w-full flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-400">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-1">
          <dt>{label}</dt>
          <dd className="font-mono text-neutral-300">{value}</dd>
        </div>
      ))}
      {k.estimated && <div>(estimate: the api sent no usage)</div>}
    </dl>
  );
}
