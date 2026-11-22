import { scoresFor } from "../lib/scores";

/** One line of the benchmark scores the model's authors publish (lib/scores.ts). Each score's tooltip names its source. */
export function ModelScores({ modelId, className = "" }: { modelId: string; className?: string }) {
  const scores = scoresFor(modelId);
  if (scores.length === 0) return null;
  return (
    <span className={`block text-xs text-neutral-400 ${className}`}>
      {scores.map((s, i) => (
        <span key={s.label} title={s.note}>
          {i > 0 && " · "}
          {s.label} {s.value ?? <span className="text-neutral-500">not published</span>}
        </span>
      ))}
    </span>
  );
}
