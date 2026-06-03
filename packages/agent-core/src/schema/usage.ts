// Neutral token-usage shape. Generalizes Codex `ThreadTokenUsage` so usage
// accounting in the controller is backend-agnostic. All fields optional — a
// backend reports what it knows.

export type NormalizedTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  /** The model's context window size, when the backend reports it (Codex
   *  `ThreadTokenUsage.modelContextWindow`). Hosts persist this for "how full
   *  is the context" UI / accounting. */
  contextWindow?: number;
};

export const EMPTY_TOKEN_USAGE: NormalizedTokenUsage = {};
