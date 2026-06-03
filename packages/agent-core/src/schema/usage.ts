// Neutral token-usage shape. Generalizes Codex `ThreadTokenUsage` so usage
// accounting in the controller is backend-agnostic. All fields optional — a
// backend reports what it knows.

export type NormalizedTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export const EMPTY_TOKEN_USAGE: NormalizedTokenUsage = {};
