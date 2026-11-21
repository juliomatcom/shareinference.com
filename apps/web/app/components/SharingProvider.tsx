"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, pickDefaultModel, type PublicModel } from "../lib/api";
import { useMe } from "./MeProvider";

// Provider mode (wiki-llm/web.md): the Web Worker owns WebLLM and the socket. It lives here, in the root layout, so
// client-side navigation never stops it; only Stop, a failure, signing out or closing the tab does. The UI (the
// /share page and the bottom `ShareBar`) only reads this state. It never sees consumer identity or content.

interface GpuInfo {
  vendor: string;
  architecture: string;
  shaderF16: boolean;
  maxBufferSize: number;
}

export type GpuCheck =
  { status: "checking" } | { status: "unsupported"; reason: string } | { status: "ok"; info: GpuInfo };
export type Run = "idle" | "loading" | "connecting" | "ready" | "busy" | "reconnecting" | "stopped";

export interface Stats {
  jobsServed: number;
  promptTokens: number;
  completionTokens: number;
  creditsEarned: number;
  lastJob: { promptTokens: number; completionTokens: number; decodeTokensPerS: number; credits: number } | null;
}
const ZERO_STATS: Stats = { jobsServed: 0, promptTokens: 0, completionTokens: 0, creditsEarned: 0, lastJob: null };

export const STATUS_LABEL: Record<Run, string> = {
  idle: "Not sharing",
  loading: "Loading model",
  connecting: "Connecting",
  ready: "Ready: waiting for work",
  busy: "Busy: serving a request",
  reconnecting: "Reconnecting",
  stopped: "Stopped",
};

// WebGPU is not in the DOM typings of this TypeScript version: only what is read here.
interface GpuAdapter {
  info?: { vendor?: string; architecture?: string }; // absent in older browsers
  features: { has(name: string): boolean };
  limits: { maxBufferSize: number };
}
type NavigatorGpu = { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } };

async function checkGpu(): Promise<GpuCheck> {
  if (!window.isSecureContext) {
    return {
      status: "unsupported",
      reason: "WebGPU needs a secure context: open this page on localhost or over HTTPS.",
    };
  }
  const gpu = (navigator as unknown as NavigatorGpu).gpu;
  if (!gpu) {
    return { status: "unsupported", reason: "This browser has no WebGPU. Use a recent Chrome or Edge on a desktop." };
  }
  let adapter: GpuAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    // treated like no adapter
  }
  if (!adapter) return { status: "unsupported", reason: "WebGPU is present but no GPU adapter is available." };
  const info: GpuInfo = {
    vendor: adapter.info?.vendor ?? "",
    architecture: adapter.info?.architecture ?? "",
    shaderF16: adapter.features.has("shader-f16"),
    maxBufferSize: adapter.limits.maxBufferSize,
  };
  if (!info.shaderF16) {
    return {
      status: "unsupported",
      reason: "This GPU lacks 16-bit shader support (shader-f16), which the model needs.",
    };
  }
  return { status: "ok", info };
}

/** Random id of this browser profile (identifies the device row on the server); not tied to anything personal. */
function deviceKey(): string {
  try {
    const saved = localStorage.getItem("si_device_key");
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
    const fresh = crypto.randomUUID();
    localStorage.setItem("si_device_key", fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // storage blocked: a new device each visit
  }
}

// The contributor notice is acknowledged once per account in this browser (`si_share_ack:<user id>`). The old
// browser-wide key `si_share_ack` is adopted by whoever signs in first, then ignored.
const ACK_KEY = "si_share_ack";
const ackKey = (userId: string) => `${ACK_KEY}:${userId}`;

interface Sharing {
  gpu: GpuCheck;
  /** The catalog (enabled models), ordered by id. */
  models: PublicModel[];
  selectedId: string | null;
  /** The model that `start()` will serve: the selected one. */
  model: PublicModel | null;
  /** Picks the model to serve; ignored while sharing. */
  select(id: string): void;
  run: Run;
  /** Sharing is in progress (loading, connecting, ready, busy or reconnecting). */
  active: boolean;
  progress: { value: number; text: string } | null;
  stats: Stats;
  error: string | null;
  awake: boolean;
  understood: boolean;
  /** Checks WebGPU and loads the model info; the /share page calls it on mount (once is enough). */
  prepare(): void;
  acknowledge(value: boolean): void;
  start(): Promise<void>;
  stop(): void;
  dismissError(): void;
}

const Ctx = createContext<Sharing | null>(null);

export function SharingProvider({ children }: { children: ReactNode }) {
  const { state } = useMe();
  const signedIn = state.status === "ready";
  const [gpu, setGpu] = useState<GpuCheck>({ status: "checking" });
  const [models, setModels] = useState<PublicModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<Run>("idle");
  const [progress, setProgress] = useState<{ value: number; text: string } | null>(null);
  const [stats, setStats] = useState<Stats>(ZERO_STATS);
  const [error, setError] = useState<string | null>(null);
  const [awake, setAwake] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const worker = useRef<Worker | null>(null);
  const prepared = useRef(false);
  const active = run !== "idle" && run !== "stopped";
  const model = models.find((m) => m.id === selectedId) ?? null;

  const prepare = useCallback(() => {
    if (prepared.current) return;
    prepared.current = true;
    void checkGpu()
      .then(setGpu)
      .catch(() => setGpu({ status: "unsupported", reason: "Could not check WebGPU in this browser." }));
    void api<{ models: PublicModel[] }>("/public/models").then((res) => {
      const list = res.data?.models ?? [];
      setModels(list);
      setSelectedId((cur) =>
        cur !== null && list.some((m) => m.id === cur) ? cur : (pickDefaultModel(list)?.id ?? null),
      );
    });
  }, []);

  const select = useCallback(
    (id: string) => {
      if (!active) setSelectedId(id);
    },
    [active],
  );

  const userId = state.status === "ready" ? state.me.id : null;
  useEffect(() => {
    if (userId === null) {
      setUnderstood(false);
      return;
    }
    try {
      if (localStorage.getItem(ackKey(userId)) === "1") setUnderstood(true);
      else if (localStorage.getItem(ACK_KEY) === "1") {
        localStorage.setItem(ackKey(userId), "1");
        setUnderstood(true);
      } else setUnderstood(false);
    } catch {
      // storage blocked: the checkbox is needed each visit
    }
  }, [userId]);
  const acknowledge = useCallback(
    (value: boolean) => {
      setUnderstood(value);
      if (userId === null) return;
      try {
        if (value) localStorage.setItem(ackKey(userId), "1");
        else {
          localStorage.removeItem(ackKey(userId));
          localStorage.removeItem(ACK_KEY);
        }
      } catch {
        // not remembered
      }
    },
    [userId],
  );

  // Screen Wake Lock while sharing and visible; the browser drops it when the tab is hidden, so ask again then.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let lock: WakeLockSentinel | null = null;
    let requesting = false;
    const acquire = async () => {
      if (cancelled || requesting || lock || document.visibilityState !== "visible" || !("wakeLock" in navigator))
        return;
      requesting = true;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        // The effect may have been cleaned up while the request was pending: do not leak the lock.
        if (cancelled) return void sentinel.release();
        lock = sentinel;
        setAwake(true);
        sentinel.addEventListener("release", () => {
          if (lock === sentinel) lock = null;
          if (!cancelled) setAwake(false);
        });
      } catch {
        // denied (battery saver, permissions policy): sharing still works, the screen may sleep
      } finally {
        requesting = false;
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
      setAwake(false);
    };
  }, [active]);

  // Tell the worker when the machine may just have come back (tab visible again, page resumed, network up): it checks
  // the connection at once instead of waiting for timers that do not run while the PC is idle or asleep.
  useEffect(() => {
    if (!active) return;
    const wake = () => {
      if (document.visibilityState === "visible") worker.current?.postMessage({ type: "wake" });
    };
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("resume", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("resume", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
    };
  }, [active]);

  // The provider sits in the root layout, so this runs only when the whole app goes away (tab closed).
  useEffect(() => () => worker.current?.terminate(), []);

  const end = useCallback((message?: string) => {
    worker.current?.terminate();
    worker.current = null;
    if (message) setError(message);
    setProgress(null);
    setRun("stopped");
  }, []);

  // Signing out (or losing the session) ends sharing: the worker's tokens belong to that account.
  useEffect(() => {
    if (!signedIn && worker.current) end();
  }, [signedIn, end]);

  const onMessage = useCallback(
    (w: Worker, data: Record<string, unknown>) => {
      switch (data.type) {
        case "status":
          setRun(data.state as Run);
          if (data.state === "ready") setProgress(null);
          if (data.state === "stopped") {
            w.terminate();
            worker.current = null;
          }
          break;
        case "progress":
          setProgress({ value: Number(data.progress) || 0, text: String(data.text ?? "") });
          break;
        case "stats": {
          // The frame's totals are the account's lifetime numbers; this session is the sum of its own jobs since
          // "Turn ON" (it survives reconnects, which a per-connection counter would not).
          const job = (data.stats as Stats).lastJob;
          if (job) {
            setStats((s) => ({
              jobsServed: s.jobsServed + 1,
              promptTokens: s.promptTokens + job.promptTokens,
              completionTokens: s.completionTokens + job.completionTokens,
              creditsEarned: s.creditsEarned + job.credits,
              lastJob: job,
            }));
          }
          break;
        }
        case "need-token":
          // A fresh single-use token for every connection attempt, including reconnects.
          void api<{ token: string }>("/worker-token", { method: "POST" }).then((res) => {
            if (worker.current !== w) return;
            if (res.ok && res.data) w.postMessage({ type: "token", token: res.data.token });
            else if (res.status === 401 || res.status === 403)
              end("Your session ended. Sign in again to keep sharing.");
            else w.postMessage({ type: "token-failed" });
          });
          break;
        case "fatal":
          end(String(data.message));
          break;
      }
    },
    [end],
  );

  const start = useCallback(async () => {
    if (gpu.status !== "ok" || !model || !understood || worker.current) return;
    setError(null);
    setStats(ZERO_STATS);
    setProgress({ value: 0, text: "Starting" });
    setRun("loading");
    const config = await api<{ apiPublicUrl: string }>("/public/config");
    if (!config.ok || !config.data) {
      setError("Could not reach the server.");
      setProgress(null);
      setRun("idle");
      return;
    }
    const w = new Worker("/share-worker.js", { type: "module" });
    worker.current = w;
    w.onmessage = (e) => onMessage(w, e.data);
    w.onerror = () => end("The sharing worker failed to start (is the model CDN reachable?).");
    w.postMessage({
      type: "start",
      model: model.webllmId,
      contextWindow: model.contextWindow,
      apiUrl: config.data.apiPublicUrl,
      deviceKey: deviceKey(),
      gpu: gpu.info,
    });
  }, [gpu, model, understood, onMessage, end]);

  const stop = useCallback(() => {
    const w = worker.current;
    if (!w) return;
    w.postMessage({ type: "stop" });
    // A model still loading cannot be interrupted: give a clean stop a moment, then end the worker.
    setTimeout(() => {
      if (worker.current === w) end();
    }, 3_000);
  }, [end]);

  const dismissError = useCallback(() => setError(null), []);

  const value = useMemo<Sharing>(
    () => ({
      gpu,
      models,
      selectedId,
      model,
      select,
      run,
      active,
      progress,
      stats,
      error,
      awake,
      understood,
      prepare,
      acknowledge,
      start,
      stop,
      dismissError,
    }),
    [
      gpu,
      models,
      selectedId,
      model,
      select,
      run,
      active,
      progress,
      stats,
      error,
      awake,
      understood,
      prepare,
      acknowledge,
      start,
      stop,
      dismissError,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSharing(): Sharing {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSharing outside SharingProvider");
  return ctx;
}
