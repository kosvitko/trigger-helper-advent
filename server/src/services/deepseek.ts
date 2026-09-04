import {
  ASK_DEMO_MODEL_TIERS,
  type LlmUsage,
} from "@trigger-helper/shared";
import { Agent, fetch as undiciFetch } from "undici";
import type { Env } from "../config/env.js";
import { estimateCost } from "./pricing.js";

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
  /** Override model id (DeepSeek or ProxyAPI provider/model). */
  model?: string;
};

/**
 * Long open/L / Sonnet answers — up to 1 hour.
 * Undici defaults headersTimeout/bodyTimeout to 300s; without a custom Agent
 * Node fetch fails with "fetch failed: Headers Timeout Error" while the LLM
 * is still generating (seen ~5 min on ProxyAPI + Claude Sonnet).
 *
 * Must use undici's own fetch + Agent together — mixing Agent from the
 * `undici` package with Node's global fetch causes
 * "invalid onRequestStart method".
 */
const LLM_FETCH_TIMEOUT_MS = 3_600_000;

const llmDispatcher = new Agent({
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
  connectTimeout: 60_000,
});

/**
 * Provider completion ceilings differ; open/L asks for 30k but gpt-4o-mini
 * rejects >16384. Clamp per model before the request.
 */
function clampMaxTokens(model: string, requested: number): number {
  const m = model.toLowerCase();
  let ceiling = requested;

  if (m.includes("gpt-4o-mini") || m.includes("gpt-3.5")) {
    ceiling = 16_384;
  } else if (m.includes("gpt-4o") || m.includes("gpt-4-turbo")) {
    ceiling = 16_384;
  } else if (m.includes("claude") || m.includes("sonnet") || m.includes("opus")) {
    ceiling = 64_000;
  } else if (m.includes("gemini")) {
    ceiling = 65_536;
  } else if (m.includes("deepseek")) {
    ceiling = 8_192;
  } else if (m.includes("/")) {
    // Unknown ProxyAPI model — stay under common OpenAI-compatible cap
    ceiling = 16_384;
  }

  return Math.min(requested, ceiling);
}

function formatLlmTransportError(label: string, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`${label}: Unknown error`);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  const detail = causeText || error.message;

  if (
    error.name === "TimeoutError" ||
    detail.includes("aborted due to timeout")
  ) {
    return new Error(
      `${label}: таймаут ожидания ответа (${LLM_FETCH_TIMEOUT_MS / 60_000} мин)`,
    );
  }
  if (/Headers Timeout/i.test(detail)) {
    return new Error(
      `${label}: нет HTTP-заголовков ответа вовремя (headers timeout). Модель ещё генерирует или прокси оборвал соединение.`,
    );
  }
  if (/Body Timeout/i.test(detail)) {
    return new Error(
      `${label}: тело ответа оборвалось по таймауту (body timeout).`,
    );
  }
  if (/fetch failed/i.test(error.message) || /onRequestStart/i.test(detail)) {
    return new Error(`${label}: соединение оборвалось (${detail})`);
  }
  return error;
}

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

type ChatApiResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
    };
  }>;
  usage?: RawUsage;
  error?: {
    message?: string;
  };
};

export type ChatResult = {
  reply: string;
  usage: LlmUsage;
  finishReason?: string;
  latency_ms: number;
};

export type DemoModelInfo = {
  tier: "weak" | "mid" | "strong";
  label: string;
  model: string;
  via: "proxyapi" | "deepseek";
};

function normalizeUsage(
  displayModel: string,
  raw?: RawUsage,
  priceModel?: string,
): LlmUsage {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const cacheHit = raw?.prompt_cache_hit_tokens ?? 0;
  const cacheMiss =
    raw?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit);

  const normalized: RawUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: raw?.total_tokens ?? promptTokens + completionTokens,
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: cacheMiss,
  };

  return {
    model: displayModel,
    prompt_tokens: normalized.prompt_tokens!,
    completion_tokens: normalized.completion_tokens!,
    total_tokens: normalized.total_tokens!,
    prompt_cache_hit_tokens: cacheHit,
    prompt_cache_miss_tokens: cacheMiss,
    ...estimateCost(priceModel ?? displayModel, normalized),
  };
}

function isProxyModelId(model: string): boolean {
  return model.includes("/");
}

export class DeepSeekService {
  constructor(private readonly env: Env) {}

  hasProxyApi(): boolean {
    return Boolean(this.env.PROXYAPI_API_KEY);
  }

  /** Day05 weak/mid/strong — ProxyAPI when key present, else DeepSeek fallbacks. */
  getDemoModels(): DemoModelInfo[] {
    const fromEnv = this.env.DEMO_MODELS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const useProxy = this.hasProxyApi();

    return ASK_DEMO_MODEL_TIERS.map((tier, index) => {
      const override = fromEnv?.[index];
      const model =
        override ??
        (useProxy ? tier.proxyModel : tier.deepseekModel);
      return {
        tier: tier.tier,
        label: tier.label,
        model,
        via: isProxyModelId(model) && useProxy ? "proxyapi" : "deepseek",
      };
    });
  }

  private resolveEndpoint(model: string): {
    url: string;
    apiKey: string;
    label: string;
  } {
    if (isProxyModelId(model)) {
      if (!this.env.PROXYAPI_API_KEY) {
        throw new Error(
          `Model "${model}" needs PROXYAPI_API_KEY (OpenAI-compatible ProxyAPI)`,
        );
      }
      const base = this.env.PROXYAPI_BASE_URL.replace(/\/$/, "");
      return {
        url: `${base}/chat/completions`,
        apiKey: this.env.PROXYAPI_API_KEY,
        label: "ProxyAPI",
      };
    }

    return {
      url: "https://api.deepseek.com/chat/completions",
      apiKey: this.env.DEEPSEEK_API_KEY,
      label: "DeepSeek",
    };
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = options.model ?? this.env.DEEPSEEK_MODEL;
    const endpoint = this.resolveEndpoint(model);

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (options.maxTokens !== undefined) {
      body.max_tokens = clampMaxTokens(model, options.maxTokens);
    }
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const started = Date.now();
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      // Same undici package as Agent (not Node global fetch) — avoids
      // "invalid onRequestStart method" from version mismatch.
      response = await undiciFetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
        dispatcher: llmDispatcher,
      });
    } catch (error) {
      throw formatLlmTransportError(endpoint.label, error);
    }

    const latency_ms = Date.now() - started;
    const payload = (await response.json()) as ChatApiResponse;

    if (!response.ok) {
      const message = payload.error?.message ?? response.statusText;
      throw new Error(
        `${endpoint.label} error (${response.status}): ${message}`,
      );
    }

    const choice = payload.choices?.[0];
    const reply = choice?.message?.content?.trim();
    if (!reply) {
      throw new Error(`${endpoint.label} returned an empty reply`);
    }

    const resolvedModel = payload.model ?? model;

    return {
      reply,
      usage: normalizeUsage(resolvedModel, payload.usage, model),
      finishReason: choice?.finish_reason,
      latency_ms,
    };
  }
}

export function createDeepSeekService(env: Env): DeepSeekService {
  return new DeepSeekService(env);
}
