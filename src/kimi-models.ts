/** One Kimi Code model. Kimi models have no family alias: they route by exact id. */
export interface KimiModel {
  readonly id: string;
  /** The effort values the model takes. Empty when the model has fixed thinking. */
  readonly reasoningEfforts: readonly string[];
}

// Source: https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-10-28).
// The docs list these models for Kimi Code. They are not live-verified on this route.
const ADJUSTABLE_EFFORTS = ["low", "high", "max"] as const;

export const KIMI_MODELS: readonly KimiModel[] = [
  { id: "k3.1-pro", reasoningEfforts: ADJUSTABLE_EFFORTS },
  { id: "k3.1-pro-highspeed", reasoningEfforts: ADJUSTABLE_EFFORTS },
  { id: "k3", reasoningEfforts: ADJUSTABLE_EFFORTS },
  { id: "k3-256k", reasoningEfforts: ADJUSTABLE_EFFORTS },
  { id: "kimi-for-coding", reasoningEfforts: ADJUSTABLE_EFFORTS },
  // The Highspeed coding model has fixed thinking, not an adjustable effort.
  { id: "kimi-for-coding-highspeed", reasoningEfforts: [] },
];
