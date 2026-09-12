import type {
  AgentInstance,
  AgentMessage,
  LlmUsage,
} from "@trigger-helper/shared";
import type {
  ChatMessage,
  ChatResult,
  DeepSeekService,
} from "../deepseek.js";
import { contextLimitForModel } from "../model-cost-tier.js";
import { costRubFromUsage } from "../pricing.js";
import { buildSystemPrompt } from "./presets.js";
import {
  estimateMessagesBreakdown,
  estimateTokens,
  type TokenBreakdown,
} from "./token-estimate.js";

const HISTORY_TAIL = 10;
/** Day08 full mode: whole thread up to the day07 persisted tail. */
const HISTORY_FULL_CAP = 100;
const AGENT_MAX_TOKENS = 1_200;
/** Day08 compression defaults. */
export const COMPRESS_KEEP_LAST = 4;
const COMPRESS_MAX_TOKENS = 700;
/** Per-message slice when building the compression transcript. */
const COMPRESS_MESSAGE_CHAR_CAP = 4_000;

const COMPRESS_SYSTEM_PROMPT = [
  "Ты — сервис сжатия истории диалога ассистента самопомощи (зона боли, триггерные точки, упражнения).",
  "Сожми переписку в короткую сводку на русском, не более 120 слов, короткими пунктами:",
  "1) что беспокоит пользователя (зона, точки, симптомы);",
  "2) что уже рекомендовано и что он попробовал;",
  "3) важные ограничения и договорённости (в т.ч. «при остром — к врачу»);",
  "4) открытые вопросы.",
  "Только факты из переписки, максимум смысла на минимум слов: без выдумок, без воды, без формул вежливости и без обращений к пользователю.",
].join("\n");

/** Day08: `tail` — sliding window, `full` — вся история (cap 100). */
export type AgentHistoryMode = "tail" | "full";

/** Window sizes reported to the UI (day08). */
export const AGENT_HISTORY_CAPS = {
  tail: HISTORY_TAIL,
  full: HISTORY_FULL_CAP,
} as const;

export type AgentRunOverrides = {
  model?: string;
  temperature?: number;
  /** Default `tail` — last HISTORY_TAIL messages only. */
  historyMode?: AgentHistoryMode;
};

/** Request-size facts for the day08 UI (estimate; API usage is the fact). */
export type AgentRunTokens = {
  estimate: TokenBreakdown;
  limit: number;
  historyMode: AgentHistoryMode;
  /** History messages actually put into the request. */
  historySent: number;
};

export type AgentRunOk = {
  reply: string;
  usage: LlmUsage;
  latency_ms: number;
  model: string;
  temperature: number;
  cost_rub: number;
  overridesApplied: { model: boolean; temperature: boolean };
  tokens: AgentRunTokens;
};

/** Day08 compress result — caller persists and bills it. */
export type CompressOk = {
  summary: string;
  /** Dialogue messages kept verbatim below the summary. */
  keptMessages: AgentMessage[];
  summarizedCount: number;
  usage: LlmUsage;
  cost_rub: number;
  model: string;
  latency_ms: number;
};

/** One idle probe call of the compression economics measurement. */
export type CompressProbeCall = {
  usage: LlmUsage;
  cost_rub: number;
  latency_ms: number;
};

/** Day08+: compression economics A/B — idle calls, the thread is NOT touched. */
export type CompressProbeOk = {
  question: string;
  model: string;
  keepLast: number;
  /** Same question on the full (tail) context — cache-warm prefix. */
  full: CompressProbeCall;
  /** The compression itself. */
  compress: CompressProbeCall & { summarizedCount: number };
  /** Same question on the compressed context, cold cache (first call). */
  compressedCold: CompressProbeCall;
  /** Same again — prefix now cache-warm. */
  compressedWarm: CompressProbeCall;
};

export class AgentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

/**
 * Day08: the request does not fit the model context window.
 * `preflight` — refused locally, nothing was spent.
 * `api` — provider itself answered 400 (context_length_exceeded).
 */
export class ContextLimitError extends Error {
  constructor(
    message: string,
    readonly details: {
      source: "preflight" | "api";
      estimate: number;
      limit: number;
      model: string;
      historyMode: AgentHistoryMode;
      breakdown?: TokenBreakdown;
    },
  ) {
    super(message);
    this.name = "ContextLimitError";
  }
}

function isContextLimitMessage(text: string): boolean {
  return /context_length_exceeded|context length|maximum context|too many tokens|reduce the length/i.test(
    text,
  );
}

function applyInputPolicy(agent: AgentInstance, raw: string): string {
  const policy = agent.inputPolicy;
  let text = policy.trim ? raw.trim() : raw;
  if (policy.requireNonEmpty && !text) {
    throw new AgentPolicyError("Пустой ввод");
  }
  if (text.length > policy.maxChars) {
    text = text.slice(0, policy.maxChars);
  }
  return text;
}

function applyOutputPolicy(agent: AgentInstance, reply: string): string {
  const policy = agent.outputPolicy;
  let text = policy.trim ? reply.trim() : reply;
  if (policy.maxChars && text.length > policy.maxChars) {
    text = `${text.slice(0, policy.maxChars - 1)}…`;
  }
  return text;
}

function historyToChat(
  messages: AgentMessage[],
  mode: AgentHistoryMode,
): ChatMessage[] {
  // Compression summaries stay in the request regardless of the window —
  // they stand in for the dialogue that was dropped.
  const summaries = messages.filter((m) => m.role === "system");
  const dialogue = messages.filter((m) => m.role !== "system");
  const cap = mode === "full" ? HISTORY_FULL_CAP : HISTORY_TAIL;

  const out: ChatMessage[] = [];
  for (const m of summaries) {
    out.push({ role: "system", content: m.content });
  }
  for (const m of dialogue.slice(-cap)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Day09: dialogue messages after the latest system summary (thread tail). */
export function dialogueSinceLastSummary(messages: AgentMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") break;
    count++;
  }
  return count;
}

/**
 * Day09: auto-compress trigger. Counts only what would go into the summary —
 * dialogue after the last summary minus the keepLast tail (the tail stays
 * verbatim and must not speed up the rhythm). Fires at `>= every`; derived
 * from the thread alone, so restarts never shift it.
 */
export function shouldAutoCompress(
  history: AgentMessage[],
  every: number,
  keepLast: number = COMPRESS_KEEP_LAST,
): boolean {
  if (!(every > 0)) return false;
  return dialogueSinceLastSummary(history) - keepLast >= every;
}

/**
 * LlmAgent — entity for day06 (name avoids clash with undici.Agent).
 * Owns config + light I/O policies + 3 context layers + run().
 */
export class LlmAgent {
  constructor(
    private readonly deepSeek: DeepSeekService,
    private readonly defaultModel: string,
    /** Day08 demo: >0 forces one small window for every model. */
    private readonly contextLimitOverride = 0,
  ) {}

  /** Effective context window for a model (DEMO_CONTEXT_LIMIT wins). */
  contextLimit(model: string): number {
    return this.contextLimitOverride > 0
      ? this.contextLimitOverride
      : contextLimitForModel(model);
  }

  async run(
    agent: AgentInstance,
    rawInput: string,
    history: AgentMessage[],
    overrides: AgentRunOverrides = {},
  ): Promise<AgentRunOk> {
    const input = applyInputPolicy(agent, rawInput);
    const model = overrides.model ?? agent.defaultModel ?? this.defaultModel;
    const temperature =
      overrides.temperature ?? agent.defaultTemperature ?? 0.7;
    const historyMode: AgentHistoryMode = overrides.historyMode ?? "tail";

    const systemPrompt = buildSystemPrompt(agent);
    const historyChat = historyToChat(history, historyMode);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyChat,
      { role: "user", content: input },
    ];

    const estimate = estimateMessagesBreakdown({
      system: systemPrompt,
      history: historyChat,
      user: input,
    });
    const limit = this.contextLimit(model);
    const tokens: AgentRunTokens = {
      estimate,
      limit,
      historyMode,
      historySent: historyChat.length,
    };

    // Reserve the completion budget — exceeding it fails upstream too.
    // DEMO_CONTEXT_LIMIT emulates a prompt window for the demo; the completion
    // reserve applies to real provider limits only — a forced window smaller
    // than the budget would otherwise refuse every ask.
    const reserve = this.contextLimitOverride > 0 ? 0 : AGENT_MAX_TOKENS;
    if (estimate.total + reserve > limit) {
      throw new ContextLimitError(
        `Запрос ≈${estimate.total} ток — не влезает в контекст «${model}» ` +
          `(${limit} ток, история: ${historyMode}). Сожмите историю или верните tail.`,
        {
          source: "preflight",
          estimate: estimate.total,
          limit,
          model,
          historyMode,
          breakdown: estimate,
        },
      );
    }

    let result: ChatResult;
    try {
      result = await this.deepSeek.chat(messages, {
        maxTokens: AGENT_MAX_TOKENS,
        temperature,
        model,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (isContextLimitMessage(text)) {
        throw new ContextLimitError(
          `Провайдер отказал: переполнение контекста (${model}, лимит ≈${limit} ток). ${text}`,
          {
            source: "api",
            estimate: estimate.total,
            limit,
            model,
            historyMode,
            breakdown: estimate,
          },
        );
      }
      throw error;
    }

    const reply = applyOutputPolicy(agent, result.reply);
    return {
      reply,
      usage: result.usage,
      latency_ms: result.latency_ms,
      model: result.usage.model,
      temperature,
      cost_rub: costRubFromUsage(result.usage),
      overridesApplied: {
        model: Boolean(overrides.model),
        temperature: overrides.temperature !== undefined,
      },
      tokens,
    };
  }

  /**
   * Day08: replace the old part of the thread with one cheap summary.
   * Returns the summary + the verbatim tail; the caller persists it via
   * ThreadStore.replace and records the usage in the ledger.
   */
  async compress(params: {
    history: AgentMessage[];
    keepLast?: number;
    model?: string;
  }): Promise<CompressOk> {
    const keepLast = Math.max(
      0,
      Math.floor(params.keepLast ?? COMPRESS_KEEP_LAST),
    );
    // Earlier summaries are folded into the new one — never stacked.
    const summaries = params.history.filter((m) => m.role === "system");
    const dialogue = params.history.filter((m) => m.role !== "system");
    const keptMessages = keepLast > 0 ? dialogue.slice(-keepLast) : [];
    const toSummarize = [
      ...summaries,
      ...dialogue.slice(0, dialogue.length - keptMessages.length),
    ];

    if (toSummarize.length === 0) {
      throw new AgentPolicyError("Нечего сжимать: история уже короткая");
    }

    const model = params.model ?? this.defaultModel;
    // Compress is the recovery path for a full context: measure it against the
    // summarizer model's real window, not DEMO_CONTEXT_LIMIT (that override
    // emulates the agent's chat window — otherwise «Сжать» would refuse exactly
    // at the overflow it exists to fix).
    const limit = contextLimitForModel(model);
    const transcript = toSummarize
      .map((m) => {
        const who =
          m.role === "user"
            ? "Пользователь"
            : m.role === "assistant"
              ? "Агент"
              : "Ранее сжато";
        const content =
          m.content.length > COMPRESS_MESSAGE_CHAR_CAP
            ? `${m.content.slice(0, COMPRESS_MESSAGE_CHAR_CAP)}…`
            : m.content;
        return `${who}: ${content}`;
      })
      .join("\n\n");

    const transcriptTokens = estimateTokens(transcript) + 200;
    if (transcriptTokens + COMPRESS_MAX_TOKENS > limit) {
      throw new ContextLimitError(
        `История слишком велика для сжатия за один проход (≈${transcriptTokens} ток, лимит ${limit}).`,
        {
          source: "preflight",
          estimate: transcriptTokens,
          limit,
          model,
          historyMode: "full",
        },
      );
    }

    const result = await this.deepSeek.chat(
      [
        { role: "system", content: COMPRESS_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      { maxTokens: COMPRESS_MAX_TOKENS, temperature: 0.3, model },
    );

    return {
      summary: result.reply.trim(),
      keptMessages,
      summarizedCount: toSummarize.length,
      usage: result.usage,
      cost_rub: costRubFromUsage(result.usage),
      model: result.usage.model,
      latency_ms: result.latency_ms,
    };
  }

  /**
   * Day08+: idle A/B of compression economics. Four real calls, thread NOT
   * touched, replies discarded — only usage/cost is reported.
   * A  — same question on the full tail context (cache-warm prefix);
   * C  — the compression itself;
   * B1 — same question on the compressed context (cold cache: summary is a
   *      new prefix, nothing to hit);
   * B2 — B1 repeated (prefix cache-warm) — the honest steady-state cost.
   */
  async probeCompressEconomics(params: {
    agent: AgentInstance;
    history: AgentMessage[];
    question?: string;
    keepLast?: number;
    model?: string;
  }): Promise<CompressProbeOk> {
    const agent = params.agent;
    const model = params.model ?? agent.defaultModel ?? this.defaultModel;
    const temperature = agent.defaultTemperature ?? 0.7;
    const question =
      params.question?.trim() ||
      "Кратко напомни, о чём мы говорили в этом диалоге.";
    const keepLast = Math.max(0, Math.floor(params.keepLast ?? COMPRESS_KEEP_LAST));

    const chatOpts = {
      maxTokens: AGENT_MAX_TOKENS,
      temperature,
      model,
    } as const;
    const systemPrompt = buildSystemPrompt(agent);

    // A — full tail context, exactly what a real run() would send now.
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyToChat(params.history, "tail"),
      { role: "user", content: question },
    ];
    const full = await this.deepSeek.chat(fullMessages, chatOpts);

    // C — the compression (pure LLM side; threads.replace is the caller's job).
    const compressed = await this.compress({
      history: params.history,
      keepLast,
      model,
    });

    // B — compressed context: system prompt + summary + kept tail + question.
    const bMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: compressed.summary },
      ...compressed.keptMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: question },
    ];
    const cold = await this.deepSeek.chat(bMessages, chatOpts);
    const warm = await this.deepSeek.chat(bMessages, chatOpts);

    return {
      question,
      model: full.usage.model,
      keepLast,
      full: {
        usage: full.usage,
        cost_rub: costRubFromUsage(full.usage),
        latency_ms: full.latency_ms,
      },
      compress: {
        usage: compressed.usage,
        cost_rub: compressed.cost_rub,
        latency_ms: compressed.latency_ms,
        summarizedCount: compressed.summarizedCount,
      },
      compressedCold: {
        usage: cold.usage,
        cost_rub: costRubFromUsage(cold.usage),
        latency_ms: cold.latency_ms,
      },
      compressedWarm: {
        usage: warm.usage,
        cost_rub: costRubFromUsage(warm.usage),
        latency_ms: warm.latency_ms,
      },
    };
  }
}

export function createLlmAgent(
  deepSeek: DeepSeekService,
  defaultModel: string,
  contextLimitOverride = 0,
): LlmAgent {
  return new LlmAgent(deepSeek, defaultModel, contextLimitOverride);
}
