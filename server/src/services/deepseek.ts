import type { LlmUsage } from "@trigger-helper/shared";
import type { Env } from "../config/env.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  /** Cap completion length (Advent day02 length control). */
  maxTokens?: number;
  /** DeepSeek JSON Output mode. */
  jsonMode?: boolean;
  temperature?: number;
};

type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

type DeepSeekResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
    };
  }>;
  usage?: DeepSeekUsage;
  error?: {
    message?: string;
  };
};

export type ChatResult = {
  reply: string;
  usage: LlmUsage;
  finishReason?: string;
};

/** deepseek-chat list prices, USD / 1M tokens (Feb 2026, approximate). */
const PRICE_INPUT_CACHE_HIT_PER_M = 0.07;
const PRICE_INPUT_CACHE_MISS_PER_M = 0.27;
const PRICE_OUTPUT_PER_M = 1.1;

function estimateCostUsd(usage: DeepSeekUsage): number {
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss =
    usage.prompt_cache_miss_tokens ??
    Math.max(0, (usage.prompt_tokens ?? 0) - cacheHit);
  const output = usage.completion_tokens ?? 0;

  const inputCost =
    (cacheHit / 1_000_000) * PRICE_INPUT_CACHE_HIT_PER_M +
    (cacheMiss / 1_000_000) * PRICE_INPUT_CACHE_MISS_PER_M;
  const outputCost = (output / 1_000_000) * PRICE_OUTPUT_PER_M;

  return Number((inputCost + outputCost).toFixed(6));
}

function normalizeUsage(model: string, raw?: DeepSeekUsage): LlmUsage {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const cacheHit = raw?.prompt_cache_hit_tokens ?? 0;
  const cacheMiss =
    raw?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit);

  const normalized: DeepSeekUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: raw?.total_tokens ?? promptTokens + completionTokens,
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: cacheMiss,
  };

  return {
    model,
    prompt_tokens: normalized.prompt_tokens!,
    completion_tokens: normalized.completion_tokens!,
    total_tokens: normalized.total_tokens!,
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: cacheMiss,
    estimated_cost_usd: estimateCostUsd(normalized),
  };
}

export class DeepSeekService {
  constructor(private readonly env: Env) {}

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.env.DEEPSEEK_MODEL,
      messages,
      stream: false,
    };

    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as DeepSeekResponse;

    if (!response.ok) {
      const message = payload.error?.message ?? response.statusText;
      throw new Error(`DeepSeek API error (${response.status}): ${message}`);
    }

    const choice = payload.choices?.[0];
    const reply = choice?.message?.content?.trim();
    if (!reply) {
      throw new Error("DeepSeek API returned an empty reply");
    }

    const model = payload.model ?? this.env.DEEPSEEK_MODEL;

    return {
      reply,
      usage: normalizeUsage(model, payload.usage),
      finishReason: choice?.finish_reason,
    };
  }
}

export function createDeepSeekService(env: Env): DeepSeekService {
  return new DeepSeekService(env);
}
