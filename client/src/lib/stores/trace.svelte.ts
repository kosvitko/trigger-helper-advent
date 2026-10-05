/**
 * Стор трейса: пост-хок таймлайн ходов из run-payload (D-4, модель F-8).
 * turnId = id финального ассистент-сообщения хода; много-тулзовые раунды
 * группируются под ним. Пошаговый трейс живёт в памяти SPA-сессии +
 * write-behind в sessionStorage th.trace.v1:<agentId> (05-M-5; кэш скоупится
 * на активного агента — смена сессии = смена скоупа, ходы не смешиваются).
 */
import { SvelteMap } from "svelte/reactivity";
import { z } from "zod";
import { LlmUsageSchema } from "@trigger-helper/shared";
import type { AgentMessage, AgentRunResponse, LlmUsage } from "@trigger-helper/shared";
import { fmtRub, fmtSec, fmtTok } from "../format";

export type TraceStepKind =
  | "llm"
  | "rag"
  | "memory"
  | "compress"
  | "gate"
  | "fsm"
  | "payload"
  | "tool";

/** Данные rag_ask-шага — из tool.calls[].payload (server rag-tool.ts). */
export interface RagStepData {
  question: string;
  ok: boolean;
  dontKnow: boolean;
  topCosine: number | null;
  /** Порог dontKnow-гейта из payload (null = гейт выключен/неизвестен). */
  threshold?: number | null;
  /** Средние стадии пайплайна (Костя 041004): рерайт/пул/верификация. */
  rewrite?: { variants: string[]; tokens: number; latencyMs: number; fallback: boolean } | null;
  poolRanked?: number | null;
  keptAfterFilter?: number | null;
  injectedCount?: number | null;
  quotesValid?: number | null;
  quotesSource?: "model" | "server_fallback" | null;
  sourcesCount: number;
  quotesCount: number;
  tokens: number | null;
  costRub: number | null;
  latencyMs: number | null;
  labels: string[];
  quotes: { quote: string; source: string; section: string }[];
  error?: string;
}

/** Детали LLM-шага (обогащение 031003: раскрытая карточка ≠ дубликат sub). */
export interface LlmStepData {
  model: string;
  latencyMs: number;
  prompt: number;
  completion: number;
  total: number;
  cacheHit: number;
  costRub: number;
  /** Фрагмент ответа (полный текст — в бабле диалога). */
  replyClip: string;
}

/** Детали шага слоистой памяти: инжект-факты по слоям + токены классификации. */
export interface MemoryStepData {
  long: string[];
  working: string[];
  short: string[];
  classifyTokens: number | null;
}

/** Детали эха «Памяти задачи» (Day25). */
export interface TaskStepData {
  goal: string;
  clarified: string[];
  constraints: string[];
}

/** Детали сжатия истории (Day09). */
export interface CompressStepData {
  model: string;
  beforeCount: number;
  beforeTokens: number;
  afterCount: number;
  afterTokens: number;
  savedTokens: number;
  costRub: number;
  latencyMs: number;
}

/** F-8: TraceStep {id, kind, title, data}. */
export interface TraceStep {
  id: string;
  kind: TraceStepKind;
  title: string;
  data: {
    sub: string;
    cost: string;
    rag?: RagStepData;
    llm?: LlmStepData;
    memory?: MemoryStepData;
    task?: TaskStepData;
    compress?: CompressStepData;
    /** Варианты рерайта для карточки подшага (Костя 041004). */
    variants?: string[];
  };
}

export interface TurnBlock {
  turnId: string;
  userText: string;
  model: string;
  latencyMs: number;
  usage: LlmUsage | null;
  railViolated: boolean;
  /** Токены хода: LLM-нарратив + rag_ask. */
  tokens: number;
  costRub: number;
  steps: TraceStep[];
  /** Ход в процессе выполнения — оптимистичный placeholder (отзыв Кости 03.10). */
  pending?: boolean;
  /** QA 041003 (F1): скелет, восстановленный из сообщений треда (свежий
   *  браузер на той же сессии) — без пошаговых деталей; рельса неизвестна. */
  restored?: boolean;
}

/** База ключа кэша; ключ скоупа — `th.trace.v1:<agentId>` (изоляция сессий). */
const TRACE_KEY = "th.trace.v1";
const TRACE_VERSION = 1;
const MAX_TURNS = 50;

/* — Защитный контракт кэша: чтение только через safeParse — */

const RagStepDataSchema = z.object({
  question: z.string(),
  ok: z.boolean(),
  dontKnow: z.boolean(),
  topCosine: z.number().nullable(),
  threshold: z.number().nullable().optional(),
  rewrite: z
    .object({
      variants: z.array(z.string()),
      tokens: z.number().int().nonnegative(),
      latencyMs: z.number().int().nonnegative(),
      fallback: z.boolean(),
    })
    .nullable()
    .optional(),
  poolRanked: z.number().int().nullable().optional(),
  keptAfterFilter: z.number().int().nullable().optional(),
  injectedCount: z.number().int().nullable().optional(),
  quotesValid: z.number().int().nullable().optional(),
  quotesSource: z.enum(["model", "server_fallback"]).nullable().optional(),
  sourcesCount: z.number().int().nonnegative(),
  quotesCount: z.number().int().nonnegative(),
  tokens: z.number().int().nullable(),
  costRub: z.number().nullable(),
  latencyMs: z.number().int().nullable(),
  labels: z.array(z.string()),
  quotes: z.array(z.object({ quote: z.string(), source: z.string(), section: z.string() })),
  error: z.string().optional(),
});

const LlmStepDataSchema = z.object({
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cacheHit: z.number().int().nonnegative(),
  costRub: z.number(),
  replyClip: z.string(),
});

const MemoryStepDataSchema = z.object({
  long: z.array(z.string()),
  working: z.array(z.string()),
  short: z.array(z.string()),
  classifyTokens: z.number().int().nullable(),
});

const TaskStepDataSchema = z.object({
  goal: z.string(),
  clarified: z.array(z.string()),
  constraints: z.array(z.string()),
});

const CompressStepDataSchema = z.object({
  model: z.string(),
  beforeCount: z.number().int().nonnegative(),
  beforeTokens: z.number().int().nonnegative(),
  afterCount: z.number().int().nonnegative(),
  afterTokens: z.number().int().nonnegative(),
  savedTokens: z.number().int().nonnegative(),
  costRub: z.number(),
  latencyMs: z.number().int().nonnegative(),
});

const TraceStepSchema = z.object({
  id: z.string(),
  kind: z.enum(["llm", "rag", "memory", "compress", "gate", "fsm", "payload", "tool"]),
  title: z.string(),
  data: z.object({
    sub: z.string(),
    cost: z.string(),
    rag: RagStepDataSchema.optional(),
    llm: LlmStepDataSchema.optional(),
    memory: MemoryStepDataSchema.optional(),
    task: TaskStepDataSchema.optional(),
    compress: CompressStepDataSchema.optional(),
    variants: z.array(z.string()).optional(),
  }),
});

const TurnBlockSchema = z.object({
  turnId: z.string(),
  userText: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  usage: LlmUsageSchema.nullable(),
  railViolated: z.boolean(),
  tokens: z.number(),
  costRub: z.number(),
  steps: z.array(TraceStepSchema),
  pending: z.boolean().optional(),
  restored: z.boolean().optional(),
});

const TraceCacheSchema = z.object({
  version: z.literal(TRACE_VERSION),
  turns: z.array(TurnBlockSchema),
});

/* — Коэрсеры unknown-полей payload (payload в shared — unknown) — */

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Рерайт-мета дня 23 → интерфейс раг-шага (средние стадии, Костя 041004). */
function coerceRewrite(v: unknown): RagStepData["rewrite"] {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { variants?: unknown; tokens?: unknown; latencyMs?: unknown; fallback?: unknown };
  if (typeof o.tokens !== "number") return null;
  return {
    variants: strArr(o.variants),
    tokens: o.tokens,
    latencyMs: typeof o.latencyMs === "number" ? o.latencyMs : 0,
    fallback: o.fallback === true,
  };
}

function tokensOf(u: unknown): number | null {
  if (typeof u === "object" && u !== null) {
    return num((u as { total_tokens?: unknown }).total_tokens);
  }
  return null;
}

function rubOf(u: unknown): number | null {
  if (typeof u === "object" && u !== null) {
    return num((u as { estimated_cost_rub?: unknown }).estimated_cost_rub);
  }
  return null;
}

function isRagPayload(p: unknown): p is Record<string, unknown> {
  return typeof p === "object" && p !== null && "dontKnow" in p && "question" in p;
}

function coerceQuotes(v: unknown): { quote: string; source: string; section: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { quote: string; source: string; section: string }[] = [];
  for (const q of v) {
    if (typeof q === "object" && q !== null) {
      const o = q as { quote?: unknown; source?: unknown; section?: unknown };
      if (typeof o.quote === "string" && typeof o.source === "string") {
        out.push({
          quote: o.quote,
          source: o.source,
          section: typeof o.section === "string" ? o.section : "",
        });
      }
    }
  }
  return out;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Сборка хода из run-payload (агенты не зовутся напрямую — только этот путь). */
export function buildTurnFromRun(userText: string, res: AgentRunResponse): TurnBlock {
  const turnId = res.message.id;
  const ctx = res.context;
  const steps: TraceStep[] = [];

  // Сжатие истории (Day09 — происходит до хода)
  if (res.autoCompression) {
    const { compression, before, after } = res.autoCompression;
    steps.push({
      id: `${turnId}:compress`,
      kind: "compress",
      title: "Сжатие истории",
      data: {
        sub: `сообщ. ${before.count} → summary −${fmtTok(compression.savedTokens)} ток в окне`,
        cost: fmtTok(compression.usage.total_tokens),
        compress: {
          model: compression.model,
          beforeCount: before.count,
          beforeTokens: before.tokensEstimate,
          afterCount: after.count,
          afterTokens: after.tokensEstimate,
          savedTokens: compression.savedTokens,
          costRub: compression.cost_rub,
          latencyMs: compression.latency_ms,
        },
      },
    });
  }

  // Тулзы хода: rag_ask-карточка из структурного payload либо generic tool-call
  let ragTokens = 0;
  let ragCost = 0;
  let ragData: RagStepData | undefined;
  const calls = ctx?.tool?.calls ?? [];
  calls.forEach((call, i) => {
    if (call.name === "rag_ask" && isRagPayload(call.payload)) {
      const p = call.payload;
      const usageTokens = tokensOf(p.usage);
      const usageRub = rubOf(p.usage);
      if (usageTokens !== null) ragTokens += usageTokens;
      if (usageRub !== null) ragCost += usageRub;
      const data: RagStepData = {
        question: typeof p.question === "string" ? p.question : "",
        ok: call.ok,
        dontKnow: p.dontKnow === true,
        topCosine: num(p.topCosine),
        threshold: num(p.threshold),
        rewrite: coerceRewrite(p.rewrite),
        poolRanked: num(p.poolRanked),
        keptAfterFilter: num(p.keptAfterFilter),
        injectedCount: num(p.injectedCount),
        quotesValid: num(p.quotesValid),
        quotesSource:
          p.quotesSource === "model" || p.quotesSource === "server_fallback" ? p.quotesSource : null,
        sourcesCount: Array.isArray(p.sources) ? p.sources.length : 0,
        quotesCount: Array.isArray(p.quotes) ? p.quotes.length : 0,
        tokens: usageTokens,
        costRub: usageRub,
        latencyMs: num(p.latencyMs),
        labels: strArr(p.labels),
        quotes: coerceQuotes(p.quotes),
        error: typeof p.error === "string" ? p.error : undefined,
      };
      ragData = data;
      steps.push({
        id: `${turnId}:rag:${i}`,
        kind: "rag",
        title: "rag_ask",
        data: {
          sub: `«${data.question}»`,
          cost: usageTokens !== null ? fmtTok(usageTokens) : "—",
          rag: data,
        },
      });
      // Средние стадии пайплайна (Костя 041004: «больше шагов внутри хода»):
      // рерайт → поиск → черновик → верификация — подшаги rag_ask.
      if (data.rewrite) {
        steps.push({
          id: `${turnId}:ragrw:${i}`,
          kind: "rag",
          title: "· рерайт запроса",
          data: {
            sub: `вариантов ${data.rewrite.variants.length}${data.rewrite.fallback ? " (фолбэк: исходный запрос)" : ""}`,
            cost: fmtTok(data.rewrite.tokens),
            variants: data.rewrite.variants,
          },
        });
      }
      if (!data.dontKnow) {
        steps.push({
          id: `${turnId}:ragfind:${i}`,
          kind: "rag",
          title: "· поиск по базе",
          data: {
            sub:
              `пул ${data.poolRanked ?? "—"} → в контексте ${data.injectedCount ?? data.sourcesCount}` +
              (data.topCosine !== null ? ` · косинус top-1 ${data.topCosine.toFixed(3)}` : ""),
            cost: "0 ток",
          },
        });
        steps.push({
          id: `${turnId}:ragans:${i}`,
          kind: "llm",
          title: "· черновик по базе",
          data: {
            sub: "ответ + цитаты (jsonMode) по чанкам контекста",
            cost: data.tokens !== null ? fmtTok(data.tokens) : "—",
          },
        });
        steps.push({
          id: `${turnId}:ragver:${i}`,
          kind: "tool",
          title: "· верификация цитат",
          data: {
            sub:
              `дословно ${data.quotesValid ?? "—"}/${data.quotesCount}` +
              (data.quotesSource
                ? ` · источник: ${data.quotesSource === "model" ? "модель" : "фолбэк-фрагменты"}`
                : ""),
            cost: "—",
          },
        });
      }
    } else {
      steps.push({
        id: `${turnId}:tool:${i}`,
        kind: "tool",
        title: call.name,
        data: {
          sub: call.ok ? call.resultClip.slice(0, 90) : `ошибка: ${call.resultClip.slice(0, 90)}`,
          cost: fmtSec(call.latencyMs),
        },
      });
    }
  });

  // Гейт «не знаю» (payload.dontKnow/topCosine, D-4; порог — QA 041003)
  if (ragData?.dontKnow) {
    const cosine = ragData.topCosine !== null ? ragData.topCosine.toFixed(3) : "—";
    const thr = ragData.threshold !== null && ragData.threshold !== undefined ? ` ${ragData.threshold}` : "";
    steps.push({
      id: `${turnId}:gate`,
      kind: "gate",
      title: "Гейт «не знаю»",
      data: { sub: `косинус top-1 = ${cosine} < порога${thr} → ответ-вызов пропущен`, cost: "₽0" },
    });
  }

  // LLM-нарратив (usage — run-payload)
  steps.push({
    id: `${turnId}:llm`,
    kind: "llm",
    title: "Нарратив",
    data: {
      sub:
        ragData && !ragData.dontKnow
          ? `ответ с ${ragData.sourcesCount} источниками, метки [source › section]`
          : "ответ модели",
      cost: fmtTok(res.usage.completion_tokens),
      llm: {
        model: res.agent.model,
        latencyMs: res.latency_ms,
        prompt: res.usage.prompt_tokens,
        completion: res.usage.completion_tokens,
        total: res.usage.total_tokens,
        cacheHit: res.usage.prompt_cache_hit_tokens,
        costRub: res.usage.estimated_cost_rub,
        replyClip: res.reply.length > 240 ? `${res.reply.slice(0, 240)}…` : res.reply,
      },
    },
  });

  // Рельса-чек (Day25; средняя стадия — Костя 041004): вызов был? метки на месте?
  steps.push({
    id: `${turnId}:rail`,
    kind: "tool",
    title: "Рельса-чек",
    data: {
      sub: res.meta?.railViolated
        ? "нарушена: ответ без вызова/меток → был re-prompt"
        : ragData && !ragData.dontKnow
          ? "rag-вызов ✓ · метки источников в ответе ✓"
          : "rag-вызов ✓ (dontKnow — метки не требуются)",
      cost: "—",
    },
  });

  // Слоистая память (Day11) — если был инжект/классификация
  if (ctx?.memory) {
    const inj = ctx.memory.inject;
    const count = inj.long.length + inj.working.length + inj.short.length;
    // Классификация фактов — отдельная LLM-стадия (средняя, Костя 041004)
    if (ctx.memory.classify?.usage) {
      steps.push({
        id: `${turnId}:memcls`,
        kind: "memory",
        title: "Память · классификация",
        data: {
          sub: `факты из реплики → слои (LLM${ctx.memory.classify.latency_ms !== undefined ? `, ${ctx.memory.classify.latency_ms} мс` : ""})`,
          cost: fmtTok(ctx.memory.classify.usage.total_tokens),
        },
      });
    }
    if (count > 0 || ctx.memory.classify) {
      steps.push({
        id: `${turnId}:memory`,
        kind: "memory",
        title: "Память",
        data: {
          sub: `инжект: ${count} фактов`,
          cost: ctx.memory.classify?.usage
            ? fmtTok(ctx.memory.classify.usage.total_tokens)
            : "—",
          memory: {
            long: inj.long.slice(0, 20),
            working: inj.working.slice(0, 20),
            short: inj.short.slice(0, 20),
            classifyTokens: ctx.memory.classify?.usage?.total_tokens ?? null,
          },
        },
      });
    }
  }

  // Эхо «Памяти задачи» после экстракта хода (Day25, только rag-ходы)
  if (ctx?.chatTaskState) {
    const cts = ctx.chatTaskState;
    steps.push({
      id: `${turnId}:chattask`,
      kind: "memory",
      title: "Память задачи",
      data: {
        sub: `уточн.: ${cts.clarified.length} · огранич.: ${cts.constraints_terms.length}`,
        cost: "—",
        task: {
          goal: cts.goal,
          clarified: cts.clarified,
          constraints: cts.constraints_terms,
        },
      },
    });
  }

  return {
    turnId,
    userText,
    model: res.agent.model,
    latencyMs: res.latency_ms,
    usage: res.usage,
    railViolated: res.meta?.railViolated === true,
    tokens: res.usage.total_tokens + ragTokens,
    costRub: (res.message.cost_rub ?? res.usage.estimated_cost_rub) + ragCost,
    steps,
  };
}

class TraceStore {
  turns = new SvelteMap<string, TurnBlock>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Ключ кэша активного агента; null = сессия ещё не выбрана (boot не прошёл). */
  private scopeKey: string | null = null;

  /** Смена активного агента — lifecycle-событие (F-2), не merge: сбрасываем
   *  ходы и пересводим кэш на ключ агента. Восстановление — только через setScope. */
  setScope(agentId: string | null): void {
    const key = agentId !== null ? `${TRACE_KEY}:${agentId}` : null;
    if (key === this.scopeKey) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.turns.clear();
    this.scopeKey = key;
    if (key !== null) this.restore(key);
  }

  /** Хронология ходов (SvelteMap хранит порядок вставки). */
  get ordered(): TurnBlock[] {
    return [...this.turns.values()];
  }

  /** Сводка сессии для подвала трейса. Рельса считается только по живым
   *  ходам (restored-скелеты её не знают — QA 041003 F1). */
  totals(): { turns: number; tokens: number; rub: number; railOk: number; railTotal: number } {
    let tokens = 0;
    let rub = 0;
    let railOk = 0;
    let railTotal = 0;
    for (const t of this.turns.values()) {
      tokens += t.tokens;
      rub += t.costRub;
      if (!t.restored && !t.pending) {
        railTotal += 1;
        if (!t.railViolated) railOk += 1;
      }
    }
    return { turns: this.turns.size, tokens, rub, railOk, railTotal };
  }

  turnBy(id: string): TurnBlock | null {
    return this.turns.get(id) ?? null;
  }

  /** QA 041003 (F1): свежий браузер на той же сессии видел «Ходов нет»,
   *  хотя тред на сервере полный. Добираем скелеты ходов из сообщений
   *  треда (модель/токены/₽ — метаданные сообщения); существующие ходы
   *  (живые/из кэша) не трогаем — они богаче. */
  mergeThread(messages: AgentMessage[]): void {
    let lastUserText = "";
    let added = false;
    for (const m of messages) {
      if (m.role === "user") {
        lastUserText = m.content;
        continue;
      }
      if (m.role !== "assistant" || this.turns.has(m.id)) continue;
      this.turns.set(m.id, {
        turnId: m.id,
        userText: lastUserText,
        model: m.model ?? "—",
        latencyMs: m.latency_ms ?? 0,
        usage: m.usage ?? null,
        railViolated: false,
        tokens: m.usage?.total_tokens ?? 0,
        costRub: m.cost_rub ?? 0,
        steps: [],
        restored: true,
      });
      added = true;
    }
    while (this.turns.size > MAX_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
    if (added) this.scheduleSave();
  }

  /** Фактическая модель последнего живого хода — правда для ModelChip
   *  (QA 041003 F3: чип показывал захардкоженный дефолт, а не env-дефот). */
  lastLiveModel(): string | null {
    for (const t of [...this.turns.values()].reverse()) {
      if (!t.restored && !t.pending && t.model && t.model !== "…") return t.model;
    }
    return null;
  }

  /** Оптимистичный ход: появляется СРАЗУ при отправке вопроса (отзыв Кости:
   * «бабл трейса должен появляться сразу и наполняться по мере выполнения»).
   * Заменяется реальным ходом в addTurnFromRun. */
  static readonly PENDING_ID = "__pending__";

  beginPending(question: string): void {
    this.turns.set(TraceStore.PENDING_ID, {
      turnId: TraceStore.PENDING_ID,
      userText: question,
      model: "…",
      latencyMs: 0,
      usage: null,
      railViolated: false,
      tokens: 0,
      costRub: 0,
      pending: true,
      steps: [
        {
          id: "pending:wait",
          kind: "llm",
          title: "⏳ Выполняется…",
          data: { sub: "rag_ask → генерация ответа", cost: "…" },
        },
      ],
    });
  }

  cancelPending(): void {
    this.turns.delete(TraceStore.PENDING_ID);
  }

  /** Day25 UX SSE: обновить/добавить один шаг в pending-ходе (не batch). */
  updatePendingStep(step: string, text: string): void {
    const pending = this.turns.get(TraceStore.PENDING_ID);
    if (!pending) return;
    const titleMap: Record<string, string> = {
      rag_ask: "rag_ask",
      narrative: "Нарратив",
      thinking: "Анализ",
      memory: "Память · классификация",
      start: "Вопрос",
      // Средние стадии (Костя 041004): появляются по ходу пайплайна, а не пачкой
      rag_rewrite: "· рерайт запроса",
      rag_search: "· поиск по базе",
      rag_answer: "· черновик по базе",
      rag_verify: "· верификация цитат",
      memory_class: "Память · классификация",
      rail: "Рельса-чек",
      chattask: "Память задачи",
    };
    const kindMap: Record<string, TraceStep["kind"]> = {
      rag_ask: "rag",
      narrative: "llm",
      thinking: "llm",
      memory: "memory",
      start: "llm",
      rag_rewrite: "rag",
      rag_search: "rag",
      rag_answer: "llm",
      rag_verify: "tool",
      memory_class: "memory",
      rail: "tool",
      chattask: "memory",
    };
    const title = titleMap[step] ?? step;
    const existing = pending.steps.find((s) => s.title === title);
    if (existing) {
      existing.data.sub = text;
    } else {
      pending.steps.push({
        id: `sse:${step}`,
        kind: (kindMap[step] ?? "llm") as TraceStep["kind"],
        title,
        data: { sub: text, cost: "…" },
      });
    }
    this.turns.set(TraceStore.PENDING_ID, { ...pending }); // trigger reactivity
  }

  /** upsert-by-id: пересборка того же хода (retry) не плодит дубликаты. */
  addTurnFromRun(userText: string, res: AgentRunResponse): void {
    this.cancelPending(); // заменяем оптимистичный placeholder реальным ходом
    const turn = buildTurnFromRun(userText, res);
    this.turns.set(turn.turnId, turn);
    while (this.turns.size > MAX_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
    this.scheduleSave();
  }

  /** Write-behind: debounce 500 мс (05-M-5). */
  private scheduleSave(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 500);
  }

  private save(): void {
    const key = this.scopeKey;
    if (key === null) return; // вне сессии — писать некуда
    try {
      const turns = [...this.turns.values()].slice(-MAX_TURNS);
      sessionStorage.setItem(key, JSON.stringify({ version: TRACE_VERSION, turns }));
    } catch {
      // квота → чистый кэш, молча
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* sessionStorage недоступен — молча */
      }
    }
  }

  /** Защищённое чтение: любая ошибка/несовпадение version → чистый лист. */
  private restore(key: string): void {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const parsed = TraceCacheSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const t of parsed.data.turns) this.turns.set(t.turnId, t);
    } catch {
      /* чистый лист */
    }
  }
}

export const trace = new TraceStore();
