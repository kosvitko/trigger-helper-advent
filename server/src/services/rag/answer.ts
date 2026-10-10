import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { UsageLedgerService } from "../usage-ledger.js";
import type { LlmUsage } from "@trigger-helper/shared";
import type { DeepSeekService, ChatMessage, ChatResult, ToolSpec } from "../deepseek.js";
import { estimateTokens } from "../agent/token-estimate.js";
import { RagService, type RagStrategy, type SearchHit } from "./store.js";
import { repoRoot } from "./paths.js";
import { normalizeRu } from "./text.js";
import { listPointCards, readPointCard } from "./point-cards.js";
import type { Reranker } from "./rerank.js";
import type { QueryRewriter, RewriteResult } from "./rewrite.js";

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
 *
 * Day23 (design D-4/D-5, consilium 260930): optional second stage via flags
 * {rerank, rewrite} — cross-encoder rerank (threshold owned by the committed
 * tune artifact) and multi-query rewrite (union by per-chunk max in
 * store.rankByQueries). Arms: base (day-22 canon) / rerank / rewrite / full.
 * Rewrite feeds RETRIEVAL only — the answer call keeps the original question
 * and the day-22 «полноценный рассказ» prompt unchanged. The ledger and
 * result.usage carry answer+rewrite SUMMED (F-04-5); the split stays visible
 * in meta.rewrite. Rerank precheck runs before the rewrite spend (F-04-2).
 *
 * Day24 (design D-2/D-3/D-4): the rag branch answers in jsonMode
 * {answer, quotes} — quotes are verified SERVER-side against the injected
 * chunks (validateQuotes; 0 valid → server_fallback fragments); a json
 * format failure degrades in ONE step to the flat day-22 call; a cosine
 * top-1 dontKnow gate (data/rag/tune-dontknow.json, per-read) returns a
 * canned «не знаю» with zero LLM spend. Baseline arm untouched (quotes: []).
 */

const RAG_ASK_MODEL = "deepseek-chat";
const RAG_ASK_TEMPERATURE = 0;
const RAG_ASK_MAX_TOKENS = 900;
/** Day24 (design D-2 + smoke 03): the structured jsonMode answer call gets
 *  a per-call 2200 budget — the ear-question narrative alone blew past 1400
 *  (JSON truncated mid-string → format degradation); quotes are OUTPUT tokens
 *  on top of the day-22 narrative (900 stays the ceiling for baseline and
 *  the flat degraded call). */
const RAG_ASK_JSON_MAX_TOKENS = 2200;
const RAG_ASK_TIMEOUT_MS = 60_000; // deepseek default is 1 h — unacceptable here (deepseek.ts:60)
/** Total prompt budget (system + question + context), Cyrillic ≈ ÷2.5 (D-3). */
const RAG_ASK_PROMPT_TOKEN_BUDGET = 3_000;
/** Baseline tool-loop caps (smaller than the chat agent's 8/8 — eval path). */
const BASELINE_MAX_ROUNDS = 4;
const BASELINE_MAX_CALLS = 6;
/** Day23 (design D-3): rerank arms ignore the route k — k_final is a code
 *  constant (16–20 band; the 3k-token budget cuts the tail anyway). */
const RAG_K_FINAL = 16;

export type RagAskMode = "rag" | "baseline";

export interface RagAskInput {
  q: string;
  mode: RagAskMode;
  strategy: RagStrategy;
  k: number;
  /** Day23 rag-stage flags (design D-5); base = false/false = day-22 canon. */
  rerank?: boolean;
  rewrite?: boolean;
  /** Прогресс средних стадий в живой трейс (Костя 041004: без «пачки» в конце):
   *  rag_rewrite / rag_search / rag_answer / rag_verify — только факты, не инструкции. */
  onStage?: (stage: string, text: string) => void;
}

export interface RagAskSource {
  chunk_id: string;
  score: number;
  source: string;
  file: string;
  title: string;
  section: string;
}

/** Day24 (design D-3/Δ-6): a verified verbatim quote — source/section are
 * filled server-side from the injected-chunk map by chunk_id. Corpus v2
 * (261005 D-5): quotes matching a marked block carry author+book (ст. 1274:
 * имя автора + источник доезжает до пользователя); verbatim fragments of our
 * own fact-prose are marked paraphrase — «по:», не дословная цитата книги. */
export interface RagAskQuote {
  quote: string;
  chunk_id: string;
  source: string;
  section: string;
  author?: string;
  book?: string;
  paraphrase?: boolean;
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
  /** Day24 (design D-1/Δ-6): verified quotes — rag mode only; the baseline
   *  anchor arm returns [] (no quotes on baseline). */
  quotes: RagAskQuote[];
  usage: LlmUsage;
  meta: {
    model: string;
    latencyMs: number;
    contextTokens: number;
    /** Baseline tool-loop counters (0 for rag mode). */
    toolRounds: number;
    toolCalls: number;
    /** Day23 rag-stage extras (rag mode only, design D-5). */
    stage?: "base" | "rerank" | "rewrite" | "full";
    poolRanked?: number;
    keptAfterFilter?: number;
    injectedCount?: number;
    rerankLatencyMs?: number;
    rewrite?: {
      variants: string[];
      tokens: number;
      latencyMs: number;
      fallback: boolean;
      error?: string;
    };
    /** Day24 (design D-3/D-4, Δ-6): quote provenance — model-verified vs
     *  server-picked fallback fragments. */
    quotes_source?: "model" | "server_fallback";
    /** Model quotes that survived verification (0 when fallback engaged). */
    quotesValid?: number;
    /** One-step format degradation fired (flat day-22 call used). */
    degraded?: "format";
    /** Weak grounding flag — no content-word answer/chunk overlap (not a block). */
    grounding?: "weak";
    /** The dontKnow gate fired — canned reply, answer call skipped (₽0). */
    dontKnow?: boolean;
    topCosine?: number;
    threshold?: number;
  };
}

export class RagAnswerService {
  constructor(
    private readonly rag: RagService,
    private readonly deepSeek: DeepSeekService,
    private readonly ledger: UsageLedgerService,
    private readonly reranker: Reranker,
    private readonly rewriter: QueryRewriter,
  ) {}

  async ask(input: RagAskInput): Promise<RagAskResult> {
    const { q, mode } = input;
    const t0 = Date.now();

    let answer: string;
    let sources: RagAskSource[] = [];
    let quotes: RagAskQuote[] = [];
    let usage: LlmUsage;
    let contextTokens = 0;
    let toolRounds = 0;
    let toolCalls = 0;
    // Day23 rag-stage extras (design D-5): set in the rag branch only.
    let stageExtras: Partial<RagAskResult["meta"]> & {
      stage: "base" | "rerank" | "rewrite" | "full";
      poolRanked: number;
      keptAfterFilter: number;
      injectedCount: number;
    } | null = null;

    if (mode === "rag") {
      const useRerank = input.rerank === true;
      const useRewrite = input.rewrite === true;
      // F-04-2: the rerank precheck (model + tune artifact load) runs BEFORE
      // the rewrite spend — a broken artifact costs 0 tokens, not ~200.
      if (useRerank) await this.reranker.ensureReady();
      let rewrite: RewriteResult | null = null;
      if (useRewrite) rewrite = await this.rewriter.rewriteQueries(q);
      if (rewrite) {
        input.onStage?.(
          "rag_rewrite",
          `вариантов ${rewrite.queries.length}${rewrite.fallback ? " (фолбэк: исходный запрос)" : ""}`,
        );
      }

      // Rewrite guard (a): union by per-chunk max — the original question is
      // always in the pool (store.rankByQueries); fallback → plain rankAll.
      const ranked =
        rewrite && !rewrite.fallback && rewrite.queries.length > 0
          ? await this.rag.rankByQueries([q, ...rewrite.queries], input.strategy)
          : await this.rag.rankAll(q, input.strategy);
      let hits = ranked.hits;
      const poolRanked = hits.length;
      const stage: "base" | "rerank" | "rewrite" | "full" =
        useRerank && useRewrite ? "full" : useRerank ? "rerank" : useRewrite ? "rewrite" : "base";

      // Day24 (design D-4): dontKnow gate — cosine top-1 right after ranking,
      // BEFORE rerank/assembly. Missing/broken tune artifact = gate OFF + warn
      // (loadCompare pattern: per-read, no cache) — never a 503.
      const threshold = await loadDontKnowThreshold();
      const cosineTop1 = hits[0]?.score ?? 0;
      if (threshold !== null && cosineTop1 < threshold) {
        input.onStage?.(
          "rag_search",
          `пул ${hits.length} · косинус top-1 ${round4(cosineTop1)} < порога ${threshold} → dontKnow`,
        );
        // Canned reply — the answer call is skipped (₽0). The rewrite spend
        // (if any) still lands in the ledger; the payload carries the zero
        // usage literal (design D-4).
        await this.ledger.record(rewrite?.usage ?? zeroUsage(), { countExpensive: false });
        return {
          ok: true,
          mode,
          question: q,
          answer: dontKnowAnswer(q),
          strategy: input.strategy,
          k: input.k,
          sources: [],
          quotes: [],
          usage: zeroUsage(),
          meta: {
            model: RAG_ASK_MODEL,
            latencyMs: Date.now() - t0,
            contextTokens: 0,
            toolRounds: 0,
            toolCalls: 0,
            stage,
            poolRanked,
            keptAfterFilter: 0,
            injectedCount: 0,
            dontKnow: true,
            topCosine: round4(cosineTop1),
            threshold,
            ...rewriteExtras(rewrite),
          },
        };
      }

      let keptAfterFilter: number;
      let rerankLatencyMs: number | undefined;
      if (useRerank) {
        // Rerank arms ignore the route k (design D-3): k_final is a const.
        const reranked = await this.reranker.rerank(q, hits);
        hits = reranked.hits.slice(0, RAG_K_FINAL);
        keptAfterFilter = reranked.kept;
        rerankLatencyMs = reranked.latencyMs;
      } else {
        // base/rewrite arms keep the day-22 k normalization.
        hits = hits.slice(0, input.k);
        keptAfterFilter = hits.length;
      }
      input.onStage?.(
        "rag_search",
        `пул ${poolRanked} → в контексте ${keptAfterFilter} · косинус top-1 ${round4(cosineTop1)}`,
      );

      const assembled = assembleContext(hits);
      contextTokens = assembled.tokens;
      sources = assembled.sources;

      // Day24 (design D-2): structured jsonMode call. Rewrite guard (b) still
      // holds — the ANSWER call keeps the original question; the day-22
      // narrative prompt rides along intact, extended by the json block.
      const structured = await this.chat(
        [
          { role: "system", content: RAG_SYSTEM_JSON },
          { role: "user", content: `${CONTEXT_HEADER}${assembled.block}\n\nВопрос: ${q}` },
        ],
        false,
        undefined,
        { jsonMode: true, maxTokens: RAG_ASK_JSON_MAX_TOKENS },
      );
      const usages: LlmUsage[] = [structured.usage];
      const parsed = parseStructuredReply(structured.reply);
      let degraded: "format" | undefined;
      if (parsed) {
        answer = parsed.answer;
      } else {
        // D-3: ONE-STEP degradation, no retry (temp 0 is deterministic) — a
        // flat day-22 call; the server picks the quotes itself.
        const flat = await this.chat(
          [
            { role: "system", content: RAG_SYSTEM },
            { role: "user", content: `${CONTEXT_HEADER}${assembled.block}\n\nВопрос: ${q}` },
          ],
          false,
        );
        usages.push(flat.usage);
        answer = flat.reply;
        degraded = "format";
      }

      // D-3: verify quotes against the actually injected chunks; 0 valid →
      // server_fallback top-fragments (quotes ≥ 1 on every answer path).
      // Порядок стадий живого трейса: черновик → верификация (Костя 041004)
      input.onStage?.("rag_answer", "ответ + цитаты (jsonMode) по чанкам контекста");
      const checked = validateQuotes(parsed?.quotes ?? [], assembled.chunks);
      quotes = checked.valid.length > 0 ? checked.valid : serverFallbackQuotes(assembled.chunks);
      const weakGrounding = isWeakGrounding(answer, assembled.chunks);
      input.onStage?.(
        "rag_verify",
        `цитат дословно ${checked.valid.length}/${(parsed?.quotes ?? []).length} · ${checked.valid.length > 0 ? "модель" : "фолбэк-фрагменты"}`,
      );

      // F-04-5: ledger + result.usage see the FULL price (answer + degradation
      // + rewrite summed); the split stays visible in meta below.
      usage = sumUsages(usages);
      if (rewrite?.usage) usage = sumUsages([usage, rewrite.usage]);

      stageExtras = {
        stage,
        poolRanked,
        keptAfterFilter,
        injectedCount: sources.length,
        // QA 041003: косинус top-1 и порог — и на «богатом» ходе, не только
        // в dontKnow-гейте: отсечения по критерию читаются в трейсе всегда.
        topCosine: round4(cosineTop1),
        ...(threshold !== null ? { threshold } : {}),
        ...(rerankLatencyMs !== undefined ? { rerankLatencyMs } : {}),
        ...rewriteExtras(rewrite),
        quotes_source: checked.valid.length > 0 ? "model" : "server_fallback",
        quotesValid: checked.valid.length,
        ...(degraded ? { degraded } : {}),
        ...(weakGrounding ? { grounding: "weak" } : {}),
      };
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
      quotes,
      usage,
      meta: {
        model: RAG_ASK_MODEL,
        latencyMs: Date.now() - t0,
        contextTokens,
        toolRounds,
        toolCalls,
        ...(stageExtras ?? {}),
      },
    };
  }

  /** One chat call; rethrows RagUnavailableError untouched (routes map it to
   *  503), wraps LLM failures for the 502 path (wrap only in rag mode). */
  private async chat(
    messages: ChatMessage[],
    wrapLlmError: boolean,
    tools?: ToolSpec[],
    /** Day24 (design D-2): per-call overrides — the structured jsonMode
     *  answer call gets jsonMode + a 1400 budget; baseline/flat calls stay
     *  at 900. */
    overrides?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<ChatResult> {
    try {
      return await this.deepSeek.chat(messages, {
        model: RAG_ASK_MODEL,
        temperature: RAG_ASK_TEMPERATURE,
        maxTokens: overrides?.maxTokens ?? RAG_ASK_MAX_TOKENS,
        timeoutMs: RAG_ASK_TIMEOUT_MS,
        ...(tools?.length ? { tools } : {}),
        ...(overrides?.jsonMode ? { jsonMode: true } : {}),
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

/** Day24 (design D-2): jsonMode extension of the day-22 prompt — every
 *  narrative rule and the inline-label rule above stay INTACT; the appended
 *  block carries the literal word «json» (DeepSeek JSON Output requirement,
 *  F-05-4), the minimal schema example and the verbatim-quotes rule. */
const RAG_SYSTEM_JSON = `${RAG_SYSTEM}\n${[
  'Ответ верни только в виде json {"answer": "...", "quotes": [{"quote": "...", "chunk_id": "..."}]} — без markdown-обёрток и пояснений.',
  "В поле answer — тот же полноценный рассказ по правилам выше.",
  "В поле quotes — 2–5 дословных фрагментов из контекста без изменений и пропусков, каждый с chunk_id блока, откуда взят фрагмент.",
].join("\n")}`;

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

/** Day24 (design D-4): canonical canned reply — the answer call is skipped.
 *  041004 (фидбек Кости по видео): вопрос вшит в отказ — иначе нарратив-модель
 *  приписывала «в базе нет» соседнему вопросу из истории. */
function dontKnowAnswer(q: string): string {
  return `Не знаю — по запросу «${q.slice(0, 120)}» в базе знаний нет ничего релевантного. Уточните вопрос (мышца, симптом, техника)?`;
}

/** Zero-usage literal (design D-4): the canned dontKnow path spends nothing
 *  on the answer call — same field set as sumUsages' zero seed. */
function zeroUsage(): LlmUsage {
  return {
    model: RAG_ASK_MODEL,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    estimated_cost_usd: 0,
    estimated_cost_rub: 0,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Rewrite meta block (the F-04-5 split), shared by the answer path and the
 *  canned dontKnow return. */
function rewriteExtras(rewrite: RewriteResult | null): Partial<RagAskResult["meta"]> {
  return rewrite
    ? {
        rewrite: {
          variants: rewrite.queries,
          tokens: rewrite.usage?.total_tokens ?? 0,
          latencyMs: rewrite.latencyMs,
          fallback: rewrite.fallback,
          ...(rewrite.error ? { error: rewrite.error } : {}),
        },
      }
    : {};
}

/** Day24 (design D-3): an injected chunk — body text WITHOUT the header line
 *  `[source | section | chunk_id]`, plus the quote payload fill.
 *  Export — unit-тест validateQuotes (гейт 261009 D-3). */
export interface InjectedChunk {
  text: string;
  source: string;
  section: string;
}

const dontKnowArtifactSchema = z.object({
  builtAt: z.string().min(1),
  threshold: z.object({
    value: z.number().min(0).max(1),
    kind: z.enum(["gap-midpoint", "conservative"]),
  }),
});

/** Day24 (design D-4): per-read threshold load (loadCompare pattern — NO
 *  cache, safeParse, warn + gate-off). A missing/broken artifact disables
 *  the gate with a warning; it must never turn an ask into a 503. */
async function loadDontKnowThreshold(): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "data", "rag", "tune-dontknow.json"), "utf8");
    const parsed = dontKnowArtifactSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("[rag/answer] tune-dontknow.json schema mismatch — dontKnow гейт выключен");
      return null;
    }
    return parsed.data.threshold.value;
  } catch {
    console.warn("[rag/answer] tune-dontknow.json отсутствует — dontKnow гейт выключен");
    return null;
  }
}

const structuredReplySchema = z.object({
  answer: z.string().min(1),
  quotes: z
    .array(z.object({ quote: z.string().min(1), chunk_id: z.string().min(1) }))
    .default([]),
});

/** Lenient parse (rewrite.ts pattern): the model may wrap the JSON in code
 *  fences or prose — grab the outermost braces. Null = format failure →
 *  one-step degradation. */
function parseStructuredReply(
  reply: string,
): { answer: string; quotes: { quote: string; chunk_id: string }[] } | null {
  try {
    const match = reply.match(/\{[\s\S]*\}/);
    const parsed = structuredReplySchema.safeParse(JSON.parse(match ? match[0] : reply));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Корпус v2 (261005 D-2/D-5): парс блоков «> цитата» + «> — Автор, «Книга»»
 * из тела чанка — дословные цитаты с атрибуцией. */
function parseMarkedQuotes(body: string): { text: string; author: string; book: string }[] {
  const out: { text: string; author: string; book: string }[] = [];
  let text: string[] = [];
  let attribution: string | null = null;
  const flush = (): void => {
    if (text.length > 0 && attribution) {
      const m = attribution.match(/^—\s*(.+?),\s*«(.+?)»/);
      if (m) out.push({ text: text.join(" ").trim(), author: m[1], book: m[2] });
    }
    text = [];
    attribution = null;
  };
  for (const raw of body.split("\n")) {
    if (!raw.startsWith(">")) {
      flush();
      continue;
    }
    const ln = raw.slice(1).trim();
    if (ln.startsWith("—")) attribution = ln;
    else if (ln) text.push(ln);
  }
  flush();
  return out;
}

/** Day24 (design D-3): verify model quotes against the actually injected
 *  chunks (post token-trim — not the k-sliced hits). A quote is valid when
 *  its normalized text is a CONTINUOUS substring of the normalized body of
 *  its chunk: leading/trailing trims are fine (normalization eats them),
 *  internal «…»/omissions break the substring and are rejected. A
 *  hallucinated chunk_id is rebound when the fragment matches exactly one
 *  injected chunk; everything else drops silently into the counter.
 *  Export — unit (гейт 261009 D-3); UI-метки источников — на клиенте. */
export function validateQuotes(
  quotes: { quote: string; chunk_id: string }[],
  injected: Map<string, InjectedChunk>,
): { valid: RagAskQuote[]; dropped: number } {
  const valid: RagAskQuote[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const { quote, chunk_id } of quotes) {
    const norm = normalizeRu(quote);
    if (!norm) {
      dropped += 1;
      continue;
    }
    const direct = injected.get(chunk_id);
    let id = chunk_id;
    let chunk: InjectedChunk | undefined =
      direct && normalizeRu(direct.text).includes(norm) ? direct : undefined;
    if (!chunk) {
      const matches = [...injected.entries()].filter(([, c]) => normalizeRu(c.text).includes(norm));
      if (matches.length !== 1) {
        dropped += 1;
        continue;
      }
      id = matches[0][0];
      chunk = matches[0][1];
    }
    const key = `${id}|${norm}`;
    if (seen.has(key)) {
      dropped += 1; // duplicate fragment
      continue;
    }
    seen.add(key);
    // Корпус v2 (D-5): совпадение с маркированным блоком → автор+книга;
    // верифицированный фрагмент факт-прозы → paraphrase («по:»).
    const normMarked = parseMarkedQuotes(chunk.text).map((mq) => ({
      ...mq,
      norm: normalizeRu(mq.text),
    }));
    const marked = normMarked.find(
      (mq) => mq.norm.includes(norm) || (norm.includes(mq.norm) && mq.norm.length >= 20),
    );
    valid.push({
      quote: quote.trim(),
      chunk_id: id,
      source: chunk.source,
      section: chunk.section,
      ...(marked ? { author: marked.author, book: marked.book } : { paraphrase: true }),
    });
  }
  return { valid, dropped };
}

/** D-3 server_fallback (корпус v2, 05-MAJOR-3): сперва маркированные цитаты
 * с атрибуцией; если в чанке их нет — первый чистый абзац факт-прозы с
 * пометкой paraphrase («по:», не дословная цитата книги). Заголовки (#/##…),
 * строки-скобки и строки блоков цитат (>) в прозаический кандидат не идут. */
function serverFallbackQuotes(injected: Map<string, InjectedChunk>, limit = 2): RagAskQuote[] {
  const out: RagAskQuote[] = [];
  for (const [chunk_id, c] of injected) {
    for (const mq of parseMarkedQuotes(c.text)) {
      if (out.length >= limit) break;
      const quote = mq.text.length > 240 ? `${mq.text.slice(0, 240).trimEnd()}…` : mq.text;
      out.push({
        quote,
        chunk_id,
        source: c.source,
        section: c.section,
        author: mq.author,
        book: mq.book,
      });
    }
    if (out.length >= limit) break;
    const clean = c.text
      .split("\n")
      .filter((ln) => {
        const t = ln.trim();
        return t && !/^#{1,6}\s/.test(t) && !/^\[.*\]$/.test(t) && !t.startsWith(">");
      })
      .join("\n");
    const paragraph = (clean.split(/\n\s*\n/)[0] ?? clean).trim();
    if (!paragraph) continue;
    const quote = paragraph.length > 240 ? `${paragraph.slice(0, 240).trimEnd()}…` : paragraph;
    out.push({ quote, chunk_id, source: c.source, section: c.section, paraphrase: true });
  }
  return out;
}

/** D-3: weak-grounding flag — no content word (len ≥ 4) of the normalized
 *  answer occurs in the normalized injected texts. A flag, not a block. */
function isWeakGrounding(answer: string, injected: Map<string, InjectedChunk>): boolean {
  const normAnswer = normalizeRu(answer);
  if (!normAnswer) return true;
  const texts = normalizeRu([...injected.values()].map((c) => c.text).join("\n"));
  const tokens = normAnswer.split(" ").filter((t) => t.length >= 4);
  if (tokens.length === 0) return true;
  return !tokens.some((t) => texts.includes(t));
}

/** Greedy whole-chunk assembly: never cut inside a chunk (D-3); the tail is
 *  dropped first when over budget; at least one chunk always stays.
 *  Effective injected count may be < requested k — envelope echoes requested
 *  k, sources reflect reality (F-04-3). */
function assembleContext(hits: SearchHit[]): {
  block: string;
  tokens: number;
  sources: RagAskSource[];
  /** Day24 (design D-3): kept chunks by chunk_id — body WITHOUT the header
   *  line (a quote swallowing the header honestly fails validation and falls
   *  into server_fallback); feeds validateQuotes, server_fallback and the
   *  source/section fill of payload quotes. */
  chunks: Map<string, InjectedChunk>;
} {
  type Piece = { text: string; body: string; source: RagAskSource };
  const pieces: Piece[] = hits.map(({ chunk, score }) => {
    const header = `[${chunk.source} | ${chunk.section || "—"} | ${chunk.chunk_id}]`;
    const body = chunk.text.trim();
    return {
      text: `${header}\n${body}`,
      body,
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
  return {
    block,
    tokens,
    sources: kept.map((p) => p.source),
    chunks: new Map(
      kept.map((p) => [
        p.source.chunk_id,
        { text: p.body, source: p.source.source, section: p.source.section },
      ]),
    ),
  };
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
  reranker: Reranker;
  rewriter: QueryRewriter;
}): RagAnswerService {
  return new RagAnswerService(deps.rag, deps.deepSeek, deps.ledger, deps.reranker, deps.rewriter);
}
