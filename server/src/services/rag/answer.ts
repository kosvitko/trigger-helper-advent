import type { UsageLedgerService } from "../usage-ledger.js";
import type { LlmUsage } from "@trigger-helper/shared";
import type { DeepSeekService, ChatMessage, ChatResult, ToolSpec } from "../deepseek.js";
import { estimateTokens } from "../agent/token-estimate.js";
import { RagService, type RagStrategy, type SearchHit } from "./store.js";
import { listPointCards, readPointCard } from "./point-cards.js";

/**
 * Day22 RAG-answer service (design D-2…D-6 + addendum §7.4): question → chunks
 * → context → LLM, compared against the "usual" access path.
 *
 * mode="rag": embeddings search → top-k context → one LLM call.
 * mode="baseline": the SAME model WITHOUT embeddings — it explores the base
 * itself through the upgraded day-17 tools (list_points overview / get_point
 * full card over data/points/*.md) in a bounded tool-loop (решение Кости
 * 30.09: «обычный способ тоже должен иметь доступ к базе… но без RAG»).
 * The comparison therefore shows quality AND the cost of access: tokens and
 * wall-clock time per mode (обязательно в выводе — решение Кости 30.09).
 *
 * RagService stays LLM-free; budget throttle lives in the route (F-05-1);
 * the agent chat loop is NOT touched (day 24 wraps ask()).
 */

const RAG_ASK_MODEL = "deepseek-chat";
const RAG_ASK_TEMPERATURE = 0;
const RAG_ASK_MAX_TOKENS = 900;
const RAG_ASK_TIMEOUT_MS = 60_000; // deepseek default is 1 h — unacceptable here (deepseek.ts:60)
/** Total prompt budget (system + question + context), Cyrillic ≈ ÷2.5 (D-3). */
const RAG_ASK_PROMPT_TOKEN_BUDGET = 3_000;
/** Baseline tool-loop caps (smaller than the chat agent's 8/8 — eval path). */
const BASELINE_MAX_ROUNDS = 4;
const BASELINE_MAX_CALLS = 6;

export type RagAskMode = "rag" | "baseline";

export interface RagAskInput {
  q: string;
  mode: RagAskMode;
  strategy: RagStrategy;
  k: number;
}

export interface RagAskSource {
  chunk_id: string;
  score: number;
  source: string;
  file: string;
  title: string;
  section: string;
}

export interface RagAskResult {
  ok: true;
  mode: RagAskMode;
  question: string;
  answer: string;
  strategy: RagStrategy;
  /** Requested k (F-04-3); actual injected count is sources.length. */
  k: number;
  sources: RagAskSource[];
  usage: LlmUsage;
  meta: {
    model: string;
    latencyMs: number;
    contextTokens: number;
    /** Baseline tool-loop counters (0 for rag mode). */
    toolRounds: number;
    toolCalls: number;
  };
}

export class RagAnswerService {
  constructor(
    private readonly rag: RagService,
    private readonly deepSeek: DeepSeekService,
    private readonly ledger: UsageLedgerService,
  ) {}

  async ask(input: RagAskInput): Promise<RagAskResult> {
    const { q, mode } = input;
    const t0 = Date.now();

    let answer: string;
    let sources: RagAskSource[] = [];
    let usage: LlmUsage;
    let contextTokens = 0;
    let toolRounds = 0;
    let toolCalls = 0;

    if (mode === "rag") {
      const { hits } = await this.rag.search(q, input.strategy, input.k);
      const assembled = assembleContext(hits);
      contextTokens = assembled.tokens;
      sources = assembled.sources;
      const result = await this.chat(
        [
          { role: "system", content: RAG_SYSTEM },
          { role: "user", content: `${CONTEXT_HEADER}${assembled.block}\n\nВопрос: ${q}` },
        ],
        false,
      );
      answer = result.reply;
      usage = result.usage;
    } else {
      const loop = await this.baselineLoop(q);
      answer = loop.answer;
      sources = loop.sources;
      usage = loop.usage;
      toolRounds = loop.toolRounds;
      toolCalls = loop.toolCalls;
    }

    // Code-pinned deepseek-chat is not an expensive model (model-cost-tier) —
    // never tick the daily expensive counter.
    await this.ledger.record(usage, { countExpensive: false });

    return {
      ok: true,
      mode,
      question: q,
      answer,
      strategy: input.strategy,
      k: input.k,
      sources,
      usage,
      meta: {
        model: RAG_ASK_MODEL,
        latencyMs: Date.now() - t0,
        contextTokens,
        toolRounds,
        toolCalls,
      },
    };
  }

  /** One chat call; rethrows RagUnavailableError untouched (routes map it to
   *  503), wraps LLM failures for the 502 path (wrap only in rag mode). */
  private async chat(
    messages: ChatMessage[],
    wrapLlmError: boolean,
    tools?: ToolSpec[],
  ): Promise<ChatResult> {
    try {
      return await this.deepSeek.chat(messages, {
        model: RAG_ASK_MODEL,
        temperature: RAG_ASK_TEMPERATURE,
        maxTokens: RAG_ASK_MAX_TOKENS,
        timeoutMs: RAG_ASK_TIMEOUT_MS,
        ...(tools?.length ? { tools } : {}),
      });
    } catch (err) {
      if (!wrapLlmError) throw err;
      throw new Error(`llm failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Baseline «обычный» доступ: overview + full cards via tools, no
   *  embeddings. Mirrors the llm-agent loop pairing (day17/19/20) in
   *  miniature; read cards land in `sources` (score 0 — no embedding ranking)
   *  so the comparison shows what the model actually paid to read. */
  private async baselineLoop(q: string): Promise<{
    answer: string;
    sources: RagAskSource[];
    usage: LlmUsage;
    toolRounds: number;
    toolCalls: number;
  }> {
    const messages: ChatMessage[] = [
      { role: "system", content: BASELINE_SYSTEM },
      { role: "user", content: q },
    ];
    const sources: RagAskSource[] = [];
    const readSlugs = new Set<string>();
    const usages: LlmUsage[] = [];
    let rounds = 0;
    let calls = 0;

    let current = await this.chat(messages, false, BASELINE_TOOLS);
    usages.push(current.usage);
    while (current.toolCalls?.length && rounds < BASELINE_MAX_ROUNDS && calls < BASELINE_MAX_CALLS) {
      rounds += 1;
      messages.push({
        role: "assistant",
        content: current.reply,
        tool_calls: current.toolCalls,
      });
      let executedThisRound = 0;
      for (const call of current.toolCalls) {
        if (calls >= BASELINE_MAX_CALLS) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "skipped: cap reached" }),
          });
          continue;
        }
        calls += 1;
        executedThisRound += 1;
        const payload = await this.runBaselineTool(call, sources, readSlugs);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(payload).slice(0, 12_000),
        });
      }
      if (executedThisRound === 0) break;
      current = await this.chat(messages, false, BASELINE_TOOLS);
      usages.push(current.usage);
    }
    if (current.toolCalls?.length) {
      // Caps exhausted while the model still wants tools → final call without
      // tools produces the text (day17 behavior).
      current = await this.chat(messages, false);
      usages.push(current.usage);
    }

    return {
      answer: current.reply,
      sources,
      usage: sumUsages(usages),
      toolRounds: rounds,
      toolCalls: calls,
    };
  }

  private async runBaselineTool(
    call: { function: { name: string; arguments: string } },
    sources: RagAskSource[],
    readSlugs: Set<string>,
  ): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { error: "invalid_tool_arguments_json" };
    }
    if (call.function.name === "list_points") {
      const zone = typeof args.zone === "string" ? args.zone : undefined;
      return listPointCards(zone);
    }
    if (call.function.name === "get_point") {
      const slug = typeof args.slug === "string" ? args.slug : "";
      const card = await readPointCard(slug);
      if (!card) return { error: `card not found: ${slug} — см. list_points` };
      if (!readSlugs.has(slug)) {
        readSlugs.add(slug);
        sources.push({
          chunk_id: slug,
          score: 0, // no embedding ranking on the tool path
          source: card.source,
          file: `${slug}.md`,
          title: card.title,
          section: "",
        });
      }
      return { source: card.source, title: card.title, card: card.text };
    }
    return { error: `unknown tool: ${call.function.name}` };
  }
}

/** Day22 verbatim prompts (design D-4 + правка Кости 30.09 вечером: ответ RAG
 *  должен быть таким же полноценным рассказом, как у baseline — «лучше и
 *  быстрее», а не сухая справка; caution из контекста — в конец ответа).
 *  Citation label pinned to the context-block header `source` (pass 02 F-1);
 *  citation formatting/parsing is day 25. */
const RAG_SYSTEM = [
  "Ты — ассистент по документации проекта Trigger Helper (образовательный справочник по триггерным точкам, не медконсультация).",
  "Отвечай на вопрос читателя подробно, опираясь ТОЛЬКО на контекст ниже:",
  "— назови мышцу/точку и её отражённую боль;",
  "— приведи ключевые симптомы и похожие картины (какие ещё мышцы из контекста дают то же);",
  "— если в контексте есть техника и осторожности по теме вопроса — включи их, осторожности упомяни в конце;",
  "— если ответа в контексте нет — скажи прямо («в базе знаний этого нет»), не додумывай.",
  "Каждый факт помечай ссылкой формата `[<source> › <section>]`, где <source> — ровно тот repo-relative путь из заголовка блока (например, `[docs/product/monetization.md › 2. Тарифы]`); ничего в ссылках не перефразируй и не сокращай.",
  "Отвечай по-русски.",
].join("\n");

const BASELINE_SYSTEM = [
  "Ты — ассистент по документации проекта Trigger Helper.",
  "Тебе доступны инструменты базы точек: list_points (обзор: slug, название мышцы, зоны) и get_point (полный текст карточки по slug).",
  "Найди ответ в базе сам: посмотри обзор, прочитай подходящие карточки, как в обычной работе с файлами — без векторного поиска.",
  "Факты из карточек помечай ссылкой формата `[data/points/<slug>.md › <раздел карточки>]` (например, `[data/points/masseter.md › Техника]`).",
  "Если ответа в базе нет — скажи прямо, не выдумывай. Отвечай по-русски, кратко.",
].join("\n");

const CONTEXT_HEADER = "### Контекст из базы знаний\n";

/** Baseline toolset — same names as the atlas MCP server (day17, upgraded to
 *  cards in day22), exposed locally to the loop. */
const BASELINE_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_points",
      description:
        "Обзор базы точек (карточки data/points/*.md): slug, название мышцы, зоны отражённой боли; опциональный фильтр зоны (head/arm/shoulder/other). Полный текст — get_point по slug.",
      parameters: {
        type: "object",
        properties: {
          zone: { type: "string", enum: ["head", "arm", "shoulder", "other"] },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_point",
      description: "Полный текст карточки точки по slug (взять из list_points).",
      parameters: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
  },
];

/** Greedy whole-chunk assembly: never cut inside a chunk (D-3); the tail is
 *  dropped first when over budget; at least one chunk always stays.
 *  Effective injected count may be < requested k — envelope echoes requested
 *  k, sources reflect reality (F-04-3). */
function assembleContext(hits: SearchHit[]): {
  block: string;
  tokens: number;
  sources: RagAskSource[];
} {
  type Piece = { text: string; source: RagAskSource };
  const pieces: Piece[] = hits.map(({ chunk, score }) => {
    const header = `[${chunk.source} | ${chunk.section || "—"} | ${chunk.chunk_id}]`;
    return {
      text: `${header}\n${chunk.text.trim()}`,
      source: {
        chunk_id: chunk.chunk_id,
        score: Math.round(score * 10_000) / 10_000,
        source: chunk.source,
        file: chunk.file,
        title: chunk.title,
        section: chunk.section,
      },
    };
  });

  const kept: Piece[] = [];
  let tokens = 0;
  for (const piece of pieces) {
    const candidateTokens = estimateTokens(piece.text) + (kept.length ? 2 : 0);
    if (kept.length > 0 && tokens + candidateTokens > RAG_ASK_PROMPT_TOKEN_BUDGET) break;
    // First chunk always stays (min 1), even if oversized (D-3).
    kept.push(piece);
    tokens += candidateTokens;
  }

  const block = kept.map((p) => p.text).join("\n\n---\n\n");
  return { block, tokens, sources: kept.map((p) => p.source) };
}

/** Sum token/cost counters across loop rounds (model is pinned, so it stays). */
function sumUsages(usages: LlmUsage[]): LlmUsage {
  const zero = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    estimated_cost_usd: 0,
    estimated_cost_rub: 0,
  };
  return usages.reduce<LlmUsage>(
    (acc, u) => ({
      model: acc.model,
      prompt_tokens: acc.prompt_tokens + (u.prompt_tokens ?? 0),
      completion_tokens: acc.completion_tokens + (u.completion_tokens ?? 0),
      total_tokens: acc.total_tokens + (u.total_tokens ?? 0),
      prompt_cache_hit_tokens: acc.prompt_cache_hit_tokens + (u.prompt_cache_hit_tokens ?? 0),
      prompt_cache_miss_tokens: acc.prompt_cache_miss_tokens + (u.prompt_cache_miss_tokens ?? 0),
      estimated_cost_usd: acc.estimated_cost_usd + (u.estimated_cost_usd ?? 0),
      estimated_cost_rub: acc.estimated_cost_rub + (u.estimated_cost_rub ?? 0),
    }),
    { model: usages[0].model, ...zero },
  );
}

export function createRagAnswerService(deps: {
  rag: RagService;
  deepSeek: DeepSeekService;
  ledger: UsageLedgerService;
}): RagAnswerService {
  return new RagAnswerService(deps.rag, deps.deepSeek, deps.ledger);
}
