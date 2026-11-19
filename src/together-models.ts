export interface TogetherCapabilities {
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly images: boolean;
  readonly reasoningReplay: boolean;
}

export interface TogetherModel extends TogetherCapabilities {
  readonly id: string;
  readonly family: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export const TOGETHER_MODELS: readonly TogetherModel[] = [];

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
