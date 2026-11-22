// Every call goes to the same-origin `/api/*` rewrite, so the session cookie is first-party. The browser adds the
// Origin header; non-GET calls send a JSON body (the api rejects anything else on cookie-authenticated writes).
export interface ApiError {
  code: string;
  message: string;
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T | null;
  error: ApiError | null;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = init.method ?? "GET";
  const write = method !== "GET";
  try {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      ...(write && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body ?? {}) }),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (res.ok) return { status: res.status, ok: true, data: json as T, error: null };
    const error = (json as { error?: ApiError } | null)?.error;
    return { status: res.status, ok: false, data: null, error: error ?? { code: "error", message: "Request failed" } };
  } catch {
    return { status: 0, ok: false, data: null, error: { code: "network", message: "Could not reach the server" } };
  }
}

export interface Me {
  id: string;
  githubLogin: string;
  avatarUrl: string | null;
  displayName: string;
  deviceLabel: string | null;
  balance: number;
  createdAt: string;
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const formatNumber = (n: number) => n.toLocaleString("en-US");

export const REPO_URL = "https://github.com/juliomatcom/shareinference.com";

// Public, read-only aggregates (wiki-llm/api.md).
export interface PublicStats {
  tokensServed: number;
  activeWorkers: number;
  modelsOnline: number;
  jobsServed: number;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  gpu: string | null;
  deviceLabel: string | null;
  model: string | null;
  tokensServed: number;
  creditsEarned: number;
  tokensPerS: number | null;
  online: boolean;
}

export interface PublicModel {
  id: string;
  ggufRef: string;
  contextWindow: number;
  priceMultiplier: number;
  workersOnline: number;
  queueDepth: number;
}

/** The model the UI suggests first (the Share page marks it "Recommended"; the Playground starts on it). */
export const DEFAULT_MODEL_ID = "qwen3.5-4b";
export const pickDefaultModel = <T extends { id: string }>(models: T[]): T | undefined =>
  models.find((m) => m.id === DEFAULT_MODEL_ID) ?? models[0];

// GPU memory each model needs, in MB (measured with the engine at the model's context window, 16K unless noted: WebGPU model, KV, recurrent state and compute buffers; the api does not send it, keep it in step with `models.vram_mb`). Unknown ids show no size.
export const MODEL_VRAM_MB: Record<string, number> = {
  "qwen3.5-2b": 1491,
  "qwen3.5-4b": 3256,
  "qwen3.5-9b": 5544,
  "gemma-4-e2b": 1615,
  // Measured at its 8192 context window (the others at 16K): a 16 GB GPU or better.
  "inkling-2-mini": 13689,
};

// Credit prices, mirrored from the api (wiki-llm/economy.md): the Playground shows what a reply cost without asking the
// server. Keep in step with `apps/api/src/core/pricing.ts`; the server's settlement is the truth.
export const INPUT_CREDITS_PER_TOKEN = 1;
export const OUTPUT_CREDITS_PER_TOKEN = 5;
export const creditsFor = (promptTokens: number, completionTokens: number, priceMultiplier: number) =>
  (promptTokens * INPUT_CREDITS_PER_TOKEN + completionTokens * OUTPUT_CREDITS_PER_TOKEN) * priceMultiplier;
