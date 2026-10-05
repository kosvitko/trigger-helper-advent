import type { ToolSpec } from "../deepseek.js";
import type { RagAnswerService, RagAskQuote, RagAskSource } from "../rag/answer.js";

/**
 * Day25 (design D-2, 02-F-7 → 04-F-11): локальная тулза `rag_ask` — KISS-модуль
 * без реестра провайдеров. Конвейер дня 24 не вскрывается: dispatch зовёт
 * RagAnswerService.ask() как библиотеку в том же процессе (Q-a). В контекст
 * модели уходит компакт-рендер <4000 симв. — ТОЛЬКО ФАКТЫ (TOOL_RESULTS_POLICY,
 * llm-agent.ts:640–643: данные, а не инструкции); полный payload — в
 * tool.calls[].payload для UI/трассы.
 */

export const RAG_TOOL_NAME = "rag_ask";

/** Канон дня 24: structured + k=12 (замер 30.09 — лучший ответ-уровень). */
const RAG_K = 12;
/** 04-F-5: кап вопроса ~2k симв. — защита 3k-токенного бюджета ask(). */
const RAG_QUESTION_CHAR_CAP = 2_000;
/** 04-F-5: клип clipToolThread (4000) не должен отрезать список источников. */
const RAG_RENDER_CHAR_CAP = 4_000;
/** D-2: локальный dispatch держит внутренние 60 с — не через 90-с callMcpTool. */
const RAG_TOOL_TIMEOUT_MS = 60_000;
/** Компакт-рендер: answer ~1200–1500, топ-2–3 цитаты (04-F-5). */
const RENDER_ANSWER_CHAR_CAP = 1_500;
const RENDER_QUOTE_CHAR_CAP = 220;
const RENDER_QUOTES_COUNT = 3;

export function buildRagToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: RAG_TOOL_NAME,
      description:
        "Поиск по базе знаний Trigger Helper (триггерные точки, техники самопомощи). " +
        "Вернёт ответ по базе, цитаты и список источников [source › section] либо " +
        "dontKnow=true, если релевантного ничего нет. Вопрос формулируй самодостаточно " +
        "(с учётом истории диалога), на русском, до 2000 символов.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Самодостаточный вопрос по базе знаний (мышца, симптом, техника).",
          },
        },
        required: ["question"],
      },
    },
  };
}

/** Метка источника — тот же формат, что требует рельса в тексте ответа (D-3). */
export function ragSourceLabel(s: { source: string; section: string }): string {
  return `[${s.source} › ${s.section || "—"}]`;
}

/** Полный payload тулзы — UI-карточка и трасса (02b-F-3, аддитивно). */
export type RagToolPayload = {
  question: string;
  answer: string;
  quotes: RagAskQuote[];
  sources: RagAskSource[];
  /** Метки [source › section] для всех источников (детекция рельсы + UI). */
  labels: string[];
  dontKnow: boolean;
  topCosine: number | null;
  /** Порог dontKnow-гейта (tune-артефакт; отсутствует = гейт выключен). */
  threshold?: number | null;
  /** Средние стадии пайплайна (Костя 041004: «больше шагов в трейсе»):
   *  рерайт / ранжирование / верификация — аддитивно из result.meta. */
  rewrite?: { variants: string[]; tokens: number; latencyMs: number; fallback: boolean } | null;
  poolRanked?: number | null;
  keptAfterFilter?: number | null;
  injectedCount?: number | null;
  quotesValid?: number | null;
  quotesSource?: "model" | "server_fallback" | null;
  usage?: unknown;
  latencyMs?: number;
  /** ok:false-исход: причина ошибки вместо данных. */
  error?: string;
};

export type RagToolOutcome = {
  ok: boolean;
  /** Компактный модель-ориентированный рендер (факты, ≤4000 симв.). */
  content: string;
  /** Полный payload для trace/UI. */
  payload: RagToolPayload;
};

/** Компакт-рендер в контекст модели: только факты, без повелений (04-F-4). */
export function renderRagToolResult(p: RagToolPayload): string {
  const lines: string[] = [
    `rag_ask · dontKnow=${p.dontKnow ? "true" : "false"}` +
      (p.topCosine != null ? ` · topCosine=${p.topCosine}` : ""),
  ];
  if (p.error) {
    lines.push(`ошибка вызова: ${p.error}`);
    return lines.join("\n").slice(0, RAG_RENDER_CHAR_CAP);
  }
  const answer =
    p.answer.length > RENDER_ANSWER_CHAR_CAP
      ? `${p.answer.slice(0, RENDER_ANSWER_CHAR_CAP - 1)}…`
      : p.answer;
  lines.push(`Ответ по базе: ${answer}`);
  if (!p.dontKnow) {
    const quotes = p.quotes.slice(0, RENDER_QUOTES_COUNT);
    if (quotes.length > 0) {
      lines.push("Цитаты:");
      for (const q of quotes) {
        const text =
          q.quote.length > RENDER_QUOTE_CHAR_CAP
            ? `${q.quote.slice(0, RENDER_QUOTE_CHAR_CAP - 1)}…`
            : q.quote;
        lines.push(`- «${text}» — ${q.source} › ${q.section || "—"}`);
      }
    }
    if (p.labels.length > 0) {
      lines.push("Источники:");
      for (const label of p.labels) lines.push(`- ${label}`);
    }
  }
  const text = lines.join("\n");
  return text.length > RAG_RENDER_CHAR_CAP
    ? `${text.slice(0, RAG_RENDER_CHAR_CAP - 1)}…`
    : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rag_ask timeout (${ms} мс)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Dispatch локальной тулзы: ask({mode:"rag", strategy:"structured", k:12}),
 * внутренний кап 60 с. Кидать не должен — ошибки становятся ok:false-исходом
 * (транспорт/таймаут ≠ isError-результат, тот же деградационный контракт).
 */
export async function dispatchRagAsk(
  args: Record<string, unknown>,
  ragAnswer: RagAnswerService,
  /** Прогресс средних стадий в живой трейс (Костя 041004). */
  onStage?: (stage: string, text: string) => void,
): Promise<RagToolOutcome> {
  const question =
    typeof args.question === "string" ? args.question.trim().slice(0, RAG_QUESTION_CHAR_CAP) : "";
  if (!question) {
    const payload: RagToolPayload = {
      question: "",
      answer: "",
      quotes: [],
      sources: [],
      labels: [],
      dontKnow: false,
      topCosine: null,
      error: "invalid_question",
    };
    return { ok: false, content: JSON.stringify({ error: "invalid_question" }), payload };
  }
  try {
    // Костя 04.10: первое разговорное «болит голова» ловило dontKnow-гейт
    // (косинус разговорной формулировки против клинической базы < порога),
    // повторный вопрос с уточнением — уже нет. rewrite=true: рерайтер дня 23
    // переформулирует в варианты, гейт ранжирует объединение (per-chunk max)
    // — клинический вариант поднимает top-1 выше порога. Фолбэк безопасен.
    const result = await withTimeout(
      ragAnswer.ask({ q: question, mode: "rag", strategy: "structured", k: RAG_K, rewrite: true, onStage }),
      RAG_TOOL_TIMEOUT_MS,
    );
    const payload: RagToolPayload = {
      question,
      answer: result.answer,
      quotes: result.quotes,
      sources: result.sources,
      labels: result.sources.map((s) => ragSourceLabel(s)),
    dontKnow: result.meta.dontKnow === true,
    topCosine: result.meta.topCosine ?? null,
    threshold: result.meta.threshold ?? null,
      // Средние стадии (мета дня 23/24 — досанавливаем в payload для трейса)
      rewrite: result.meta.rewrite
        ? {
            variants: result.meta.rewrite.variants,
            tokens: result.meta.rewrite.tokens,
            latencyMs: result.meta.rewrite.latencyMs,
            fallback: result.meta.rewrite.fallback,
          }
        : null,
      poolRanked: result.meta.poolRanked ?? null,
      keptAfterFilter: result.meta.keptAfterFilter ?? null,
      injectedCount: result.meta.injectedCount ?? null,
      quotesValid: result.meta.quotesValid ?? null,
      quotesSource: result.meta.quotes_source ?? null,
      usage: result.usage,
      latencyMs: result.meta.latencyMs,
    };
    return { ok: true, content: renderRagToolResult(payload), payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload: RagToolPayload = {
      question,
      answer: "",
      quotes: [],
      sources: [],
      labels: [],
      dontKnow: false,
      topCosine: null,
      error: message,
    };
    return { ok: false, content: JSON.stringify({ error: message }), payload };
  }
}
