// Who makes each catalog model, for the provider icon and the display name (wiki-llm/web.md). Hardcoded like
// `scores.ts`: it changes only when the catalog does and the api does not need it. Ids are public model ids; an unknown
// id gets the generic chip icon and its id as its name, so a model added to the api before this table still renders.
export type ProviderId = "qwen" | "google" | "thinking-machines";

export interface Provider {
  id: ProviderId;
  name: string;
  /** Brand tint (hex) for the icon tile; the mark itself is drawn in `components/ProviderIcon.tsx`. */
  color: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  qwen: { id: "qwen", name: "Qwen", color: "#8b7cf6" },
  google: { id: "google", name: "Google", color: "#4f9cf9" },
  "thinking-machines": { id: "thinking-machines", name: "Thinking Machines", color: "#f59e6b" },
};

const PROVIDER_BY_PREFIX: [prefix: string, provider: ProviderId][] = [
  ["qwen", "qwen"],
  ["gemma", "google"],
  ["inkling", "thinking-machines"],
];

export const providerForModel = (modelId: string): Provider | undefined => {
  const hit = PROVIDER_BY_PREFIX.find(([prefix]) => modelId.startsWith(prefix));
  return hit && PROVIDERS[hit[1]];
};

export interface ModelLabel {
  name: string;
  /** Parameter count as the authors state it. */
  size: string;
}

export const MODEL_LABELS: Record<string, ModelLabel> = {
  "qwen3.5-2b": { name: "Qwen3.5 2B", size: "2B params" },
  "qwen3.5-4b": { name: "Qwen3.5 4B", size: "4B params" },
  "qwen3.5-9b": { name: "Qwen3.5 9B", size: "9B params" },
  "gemma-4-e2b": { name: "Gemma 4 E2B", size: "2B effective params" },
  "inkling-2-mini": { name: "Inkling 2 Mini", size: "26B MoE, 3.4B active" },
};

export const modelLabel = (modelId: string): ModelLabel => MODEL_LABELS[modelId] ?? { name: modelId, size: "" };
