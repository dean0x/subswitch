export interface TogetherCapabilities {
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly images: boolean;
  readonly reasoningReplay: boolean;
}

/** Which catalog facts a live check has confirmed. A false field is UNCONFIRMED. */
export interface TogetherConfirmation {
  readonly price: boolean;
  readonly images: boolean;
}

export interface TogetherModel extends TogetherCapabilities {
  /** Display name for reports and docs. Routing never reads it. */
  readonly name: string;
  readonly id: string;
  readonly family: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** List price in USD per 1,000,000 input tokens. */
  readonly priceInPerMTokens: number;
  /** List price in USD per 1,000,000 output tokens. */
  readonly priceOutPerMTokens: number;
  readonly confirmed: TogetherConfirmation;
}

/** Output token cap for a Together request when the user config sets none. */
export const TOGETHER_DEFAULT_OUTPUT_CAP = 16_384;

// The ids, context windows and prices come from Together's public model pages.
// No live check has confirmed price or image support yet, so each row is UNCONFIRMED.
// Together states no max output value. Every row uses the Subswitch default output
// cap instead, and that value is UNCONFIRMED too.
const UNCONFIRMED: TogetherConfirmation = { price: false, images: false };

export const TOGETHER_MODELS: readonly TogetherModel[] = [
  {
    name: "Qwen3.8 Flash", id: "Qwen/Qwen3.8-Flash", family: "qwen3.8-flash",
    contextWindow: 1_000_000, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: true, reasoningReplay: true,
    priceInPerMTokens: 0.15, priceOutPerMTokens: 0.47, confirmed: UNCONFIRMED,
  },
  {
    name: "DeepSeek V4 Pro", id: "deepseek-ai/DeepSeek-V4-Pro-0813", family: "deepseek-v4-pro",
    contextWindow: 1_048_576, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: false, reasoningReplay: true,
    priceInPerMTokens: 1.32, priceOutPerMTokens: 3.96, confirmed: UNCONFIRMED,
  },
  {
    name: "DeepSeek V4.1 Flash", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", family: "deepseek-v4.1-flash",
    contextWindow: 1_000_000, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: true, reasoningReplay: true,
    priceInPerMTokens: 0.30, priceOutPerMTokens: 1.20, confirmed: UNCONFIRMED,
  },
  {
    name: "GLM-5.3", id: "zai-org/GLM-5.3", family: "glm-5.3",
    contextWindow: 1_048_575, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: false, reasoningReplay: true,
    priceInPerMTokens: 1.40, priceOutPerMTokens: 4.40, confirmed: UNCONFIRMED,
  },
  {
    name: "GLM-5.3 Flash", id: "zai-org/GLM-5.3-Flash", family: "glm-5.3-flash",
    contextWindow: 1_048_575, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: true, reasoningReplay: true,
    priceInPerMTokens: 0.15, priceOutPerMTokens: 0.50, confirmed: UNCONFIRMED,
  },
  {
    name: "Kimi K3.1 Pro", id: "moonshotai/Kimi-K3.1-Pro", family: "kimi-k3.1-pro",
    contextWindow: 1_048_576, maxOutputTokens: TOGETHER_DEFAULT_OUTPUT_CAP, images: true, reasoningReplay: true,
    priceInPerMTokens: 2.00, priceOutPerMTokens: 10.00, confirmed: UNCONFIRMED,
  },
];

export const TOGETHER_DEFAULT_CAPABILITIES: TogetherCapabilities = {
  contextWindow: undefined,
  maxOutputTokens: undefined,
  // An unlisted model gets inline images. The upstream decides whether it supports them.
  images: true,
  reasoningReplay: true,
};

const TOGETHER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
const MAX_TOGETHER_MODEL_ID_LENGTH = 200;

export const isTogetherModelId = (id: string): boolean =>
  id.length <= MAX_TOGETHER_MODEL_ID_LENGTH && TOGETHER_MODEL_ID_PATTERN.test(id);
