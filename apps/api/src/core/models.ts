/** A model in the catalog: the public id consumers use, mapped to the WebLLM id providers load. */
export interface Model {
  id: string;
  webllmId: string;
  contextWindow: number;
  vramMb: number;
  priceMultiplier: number;
  enabled: boolean;
}
