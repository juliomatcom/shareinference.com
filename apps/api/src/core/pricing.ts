// The one place credit prices live (wiki-llm/economy.md).
export const INPUT_CREDITS_PER_TOKEN = 1;
export const OUTPUT_CREDITS_PER_TOKEN = 5;

/** Integer credits for a finished job; thinking tokens are completion tokens. */
export function creditsFor(promptTokens: number, completionTokens: number, priceMultiplier: number): number {
  return (promptTokens * INPUT_CREDITS_PER_TOKEN + completionTokens * OUTPUT_CREDITS_PER_TOKEN) * priceMultiplier;
}
