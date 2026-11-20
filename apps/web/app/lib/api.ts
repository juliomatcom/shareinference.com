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
  webllmId: string;
  contextWindow: number;
  priceMultiplier: number;
  workersOnline: number;
  queueDepth: number;
}

// Credit prices, mirrored from the api (wiki-llm/economy.md): the Playground shows what a reply cost without asking the
// server. Keep in step with `apps/api/src/core/pricing.ts`; the server's settlement is the truth.
export const INPUT_CREDITS_PER_TOKEN = 1;
export const OUTPUT_CREDITS_PER_TOKEN = 5;
export const creditsFor = (promptTokens: number, completionTokens: number, priceMultiplier: number) =>
  (promptTokens * INPUT_CREDITS_PER_TOKEN + completionTokens * OUTPUT_CREDITS_PER_TOKEN) * priceMultiplier;
