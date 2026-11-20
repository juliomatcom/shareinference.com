import type { Gpu } from "./protocol.js";

/** Provider-reported decode speed above this is not plausible and is clamped (stored and averaged). */
export const MAX_DECODE_TPS = 500;

export const clampTps = (tps: number): number =>
  Number.isFinite(tps) ? Math.min(Math.max(tps, 0), MAX_DECODE_TPS) : 0;

const GPU_TEXT_MAX = 48;

/** Device strings come from an untrusted browser and are shown publicly: keep a plain, short subset. */
export function cleanGpuText(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 ._()+-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GPU_TEXT_MAX)
    .trim();
}

export function sanitizeGpu(gpu: Gpu): Gpu {
  return { ...gpu, vendor: cleanGpuText(gpu.vendor), architecture: cleanGpuText(gpu.architecture) };
}

/** "apple metal-3": a short public label from the vendor and architecture; cleaned again for rows stored earlier. */
export function gpuLabel(gpu: Gpu | null): string | null {
  if (!gpu) return null;
  return [cleanGpuText(gpu.vendor), cleanGpuText(gpu.architecture)].filter(Boolean).join(" ") || null;
}
