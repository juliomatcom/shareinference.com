// Benchmark scores shown next to each model (wiki-llm/web.md). Hardcoded: they change only when the catalog does, and the
// api does not need them. Every figure is what the model's authors publish on its Hugging Face model card (read
// 2026-11-22), so they are NOT comparable across models: vendors use different settings, and no benchmark is published for
// all five. The UI shows each model's own scores and never ranks them. Ids are public model ids; an unknown id shows none.
export interface Score {
  label: string;
  /** Shown as is, with its unit; null = the authors do not publish it. */
  value: string | null;
  /** Tooltip: where it comes from and the setting. */
  note: string;
}

const card = (model: string, setting: string) => `Reported by the ${model} model card${setting ? `, ${setting}` : ""}.`;
const notPublished = (label: string, model: string): Score => ({
  label,
  value: null,
  note: `The ${model} model card does not report ${label}.`,
});

export const MODEL_SCORES: Record<string, Score[]> = {
  "qwen3.5-2b": [
    { label: "MMLU-Pro", value: "55.3%", note: card("Qwen3.5-2B", "non-thinking mode (66.5% with thinking)") },
    { label: "GPQA Diamond", value: "51.6%", note: card("Qwen3.5-2B", "thinking mode") },
    notPublished("LiveCodeBench", "Qwen3.5-2B"),
  ],
  "qwen3.5-4b": [
    { label: "MMLU-Pro", value: "79.1%", note: card("Qwen3.5-4B", "setting not stated; thinking is its default") },
    { label: "GPQA Diamond", value: "76.2%", note: card("Qwen3.5-4B", "setting not stated; thinking is its default") },
    { label: "LiveCodeBench", value: "55.8%", note: card("Qwen3.5-4B", "v6, setting not stated") },
  ],
  "qwen3.5-9b": [
    { label: "MMLU-Pro", value: "82.5%", note: card("Qwen3.5-9B", "setting not stated; thinking is its default") },
    { label: "GPQA Diamond", value: "81.7%", note: card("Qwen3.5-9B", "setting not stated; thinking is its default") },
    { label: "LiveCodeBench", value: "65.6%", note: card("Qwen3.5-9B", "v6, setting not stated") },
  ],
  "gemma-4-e2b": [
    { label: "MMLU-Pro", value: "60.0%", note: card("Gemma 4 E2B", "thinking mode per the Gemma 4 technical report") },
    {
      label: "GPQA Diamond",
      value: "43.4%",
      note: card("Gemma 4 E2B", "thinking mode per the Gemma 4 technical report"),
    },
    { label: "LiveCodeBench", value: "44.0%", note: card("Gemma 4 E2B", "v6, thinking mode per the technical report") },
  ],
  // Inkling's card publishes none of the three above, so it shows the numbers it does publish.
  "inkling-2-mini": [
    {
      label: "AA Intelligence Index",
      value: "20.1",
      note: card("Inkling-2-Mini", "Artificial Analysis Intelligence Index v5.0"),
    },
    { label: "HLE-Diamond", value: "15.2%", note: card("Inkling-2-Mini", "reasoning effort not stated") },
    { label: "SWE-bench Verified", value: "79.2%", note: card("Inkling-2-Mini", "bash only") },
  ],
};

export const scoresFor = (modelId: string): Score[] => MODEL_SCORES[modelId] ?? [];
