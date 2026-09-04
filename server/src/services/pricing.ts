/**
 * Cost estimates for ledger/UI.
 * - DeepSeek: USD list prices (display ₽ only via DeepSeek FX 103 — not for ProxyAPI).
 * - ProxyAPI: RUB list prices (Russian billing) — never convert through 103.
 */

/** Last DeepSeek top-up FX (2026-09). UI only for DeepSeek USD → ₽. */
export const DEEPSEEK_FX_RUB_PER_USD = 103;

export type ModelPrice =
  | {
      currency: "usd";
      inputPerM: number;
      outputPerM: number;
      cacheHitPerM?: number;
    }
  | {
      currency: "rub";
      inputPerM: number;
      outputPerM: number;
      cacheHitPerM?: number;
    };

const DEEPSEEK_CHAT: ModelPrice = {
  currency: "usd",
  inputPerM: 0.27,
  outputPerM: 1.1,
  cacheHitPerM: 0.07,
};

const PRICE_BY_MODEL: Record<string, ModelPrice> = {
  "deepseek-chat": DEEPSEEK_CHAT,
  "deepseek-reasoner": {
    currency: "usd",
    inputPerM: 0.55,
    outputPerM: 2.19,
    cacheHitPerM: 0.14,
  },
  // ProxyAPI demo tiers — RUB / 1M tokens (approx. pricing page); smoke-tested ids
  "gemini/gemini-2.5-flash-lite": { currency: "rub", inputPerM: 90, outputPerM: 360 },
  "gemini/gemini-2.5-flash": { currency: "rub", inputPerM: 90, outputPerM: 360 },
  "gemini/gemini-3.5-flash-lite": { currency: "rub", inputPerM: 91, outputPerM: 758 },
  "gemini/gemini-2.0-flash": { currency: "rub", inputPerM: 75, outputPerM: 300 },
  "openai/gpt-4o-mini": { currency: "rub", inputPerM: 15, outputPerM: 60 },
  "openai/gpt-4o": { currency: "rub", inputPerM: 250, outputPerM: 1000 },
  "anthropic/claude-sonnet-4-5": { currency: "rub", inputPerM: 300, outputPerM: 1500 },
  "anthropic/claude-sonnet-4-5-20250929": {
    currency: "rub",
    inputPerM: 300,
    outputPerM: 1500,
  },
  "anthropic/claude-sonnet-4-20250514": {
    currency: "rub",
    inputPerM: 300,
    outputPerM: 1500,
  },
  "anthropic/claude-haiku-4-5": {
    currency: "rub",
    inputPerM: 295,
    outputPerM: 1474,
  },
  "openai/gpt-5.6-luna": { currency: "rub", inputPerM: 60, outputPerM: 360 },
};

export function priceForModel(model: string): ModelPrice {
  const exact = PRICE_BY_MODEL[model];
  if (exact) return exact;

  const lower = model.toLowerCase();
  const short = lower.includes("/") ? lower.split("/").pop()! : lower;

  for (const [key, price] of Object.entries(PRICE_BY_MODEL)) {
    const keyLower = key.toLowerCase();
    const keyShort = keyLower.includes("/") ? keyLower.split("/").pop()! : keyLower;
    if (
      lower === keyLower ||
      short === keyShort ||
      short.startsWith(`${keyShort}-`) ||
      lower.includes(keyLower) ||
      keyLower.includes(lower)
    ) {
      return price;
    }
  }

  // provider/model without table → rub 0 (don't fake DeepSeek USD)
  if (model.includes("/")) {
    return { currency: "rub", inputPerM: 0, outputPerM: 0 };
  }
  // bare OpenAI-ish id from ProxyAPI response without table hit
  if (/^(gpt-|o\d|claude-|gemini-)/i.test(short)) {
    return { currency: "rub", inputPerM: 0, outputPerM: 0 };
  }
  return DEEPSEEK_CHAT;
}

export type EstimatedCost = {
  estimated_cost_usd: number;
  estimated_cost_rub: number;
};

export function estimateCost(
  model: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  },
): EstimatedCost {
  const price = priceForModel(model);
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss =
    usage.prompt_cache_miss_tokens ??
    Math.max(0, (usage.prompt_tokens ?? 0) - cacheHit);
  const output = usage.completion_tokens ?? 0;
  const hitRate = price.cacheHitPerM ?? price.inputPerM;
  const amount =
    (cacheHit / 1_000_000) * hitRate +
    (cacheMiss / 1_000_000) * price.inputPerM +
    (output / 1_000_000) * price.outputPerM;

  if (price.currency === "rub") {
    return {
      estimated_cost_usd: 0,
      estimated_cost_rub: Number(amount.toFixed(4)),
    };
  }

  return {
    estimated_cost_usd: Number(amount.toFixed(6)),
    estimated_cost_rub: 0,
  };
}

/** @deprecated use estimateCost — kept name for older imports */
export function estimateCostUsd(
  model: string,
  usage: Parameters<typeof estimateCost>[1],
): number {
  return estimateCost(model, usage).estimated_cost_usd;
}

/** @deprecated use DEEPSEEK_FX_RUB_PER_USD */
export const COST_FX_RUB_PER_USD = DEEPSEEK_FX_RUB_PER_USD;
