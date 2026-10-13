import type { LlmUsage } from "@trigger-helper/shared";
import type { Env } from "../config/env.js";
import type { ChatMessage, ChatResult, DeepSeekService } from "./deepseek.js";
import { createDeepSeekService } from "./deepseek.js";
import {
  createProjectSearch,
  runProjectSearch,
  type ProjectSearcher,
} from "./rag/project-search.js";

/**
 * Day32 (Pick D, гейт 261013): ядро AI-ревью — diff + изменённые файлы →
 * project-RAG (документация + код, день 31) → DeepSeek (JSON-режим) →
 * структурированное ревью: потенциальные баги / архитектурные проблемы /
 * рекомендации + вердикт approved|changes_requested.
 *
 * Триггеры живут в scripts/review-*.ts (commit / push-pre-push / PR);
 * ядро не знает, откуда пришёл diff. LLM-вызов один, jsonMode — вердикт
 * парсится без markdown-обвязки. RAG-сбой не валит ревью (degrade-not-crash,
 * правило day20): в результате честная пометка ragDegraded.
 */

export const REVIEW_DIFF_CHAR_CAP = 60_000;
export const REVIEW_FILES_CAP = 60;
/** Два вызова максимум: повтор при невалидном JSON. */
export const REVIEW_MAX_LLM_CALLS = 2;

const REVIEW_CHAR_CAP_SAFE = REVIEW_DIFF_CHAR_CAP - 200;

export type ReviewVerdict = "approved" | "changes_requested";

export type ReviewFile = {
  status: string;
  path: string;
};

export type ReviewInput = {
  /** Откуда diff: «commit <sha>», «push <range>», «PR #12 owner/repo». */
  source: string;
  /** Заголовок ветки/PR (если есть). */
  title: string;
  files: ReviewFile[];
  diff: string;
};

export type ReviewResult = {
  source: string;
  verdict: ReviewVerdict;
  summary: string;
  bugs: string[];
  architecture: string[];
  recommendations: string[];
  sources: string[];
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  truncated: boolean;
  ragDegraded: boolean;
};

export class ReviewError extends Error {}

type ReviewReply = {
  verdict: ReviewVerdict;
  summary: string;
  bugs: string[];
  architecture: string[];
  recommendations: string[];
};

export type ReviewDeps = {
  env: Env;
  /** Инъекция для тестов (по умолчанию создаётся из env). */
  llm?: DeepSeekService;
  searcher?: ProjectSearcher;
};

export function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= REVIEW_DIFF_CHAR_CAP) return { diff, truncated: false };
  return {
    diff: `${diff.slice(0, REVIEW_CHAR_CAP_SAFE)}\n… [diff обрезан: ${diff.length} > ${REVIEW_DIFF_CHAR_CAP} символов]`,
    truncated: true,
  };
}

export function buildRagQuery(input: ReviewInput): string {
  const paths = input.files
    .slice(0, 12)
    .map((f) => f.path)
    .join(", ");
  const more = input.files.length > 12 ? ` (+${input.files.length - 12} файлов)` : "";
  return `Изменения в ${paths}${more} — ревью: контракт API, обработка ошибок, типы, стек проекта`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export function parseReviewReply(reply: string): ReviewReply {
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    throw new ReviewError("ответ не JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ReviewError("ответ не объект JSON");
  }
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "approved" && verdict !== "changes_requested") {
    throw new ReviewError(`verdict не approved|changes_requested: ${JSON.stringify(verdict)}`);
  }
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) throw new ReviewError("пустой summary");
  return {
    verdict,
    summary,
    bugs: asStringArray(obj.bugs),
    architecture: asStringArray(obj.architecture),
    recommendations: asStringArray(obj.recommendations),
  };
}

function systemPrompt(): string {
  return [
    "Ты — ревьюер кода проекта Trigger Helper (TypeScript, Fastify-сервер, Svelte-клиент, shared-схемы; канон — docs/STACK.md).",
    "Тебе дают изменённые файлы и diff коммита/PR плюс фрагменты из RAG-индекса проекта (документация и код).",
    "Задача — ревью изменений по рубрикам: bugs (потенциальные баги), architecture (архитектурные проблемы), recommendations (рекомендации).",
    "Правила:",
    "- опирайся только на diff и фрагменты RAG; ничего не выдумывай;",
    "- каждая находка — с файлом и (если видно) строкой/контекстом diff;",
    "- пустая рубрика допустима — пиши «нет находок» только в summary, массив оставляй пустым;",
    "- тривиальные изменения (docs, форматирование, комментарии) — вердикт approved без придирок;",
    "Вердикт:",
    "- approved — изменения можно пушить/мержить; approved ≠ идеальный код;",
    "- changes_requested — ТОЛЬКО реальные, воспроизводимые в этом репозитории риски: баг на актуальных данных/путях, поломка контракта или API, утечка секрета, деградация прод-пути.",
    "Теоретические edge-case'ы (окружения/сценарии, которых в этом репо нет), style, именование и идеи улучшений — это recommendations, они НИКОГДА не основание для changes_requested.",
    "Ответ — строго JSON (без markdown-обвязки) по схеме:",
    '{"verdict":"approved|changes_requested","summary":"кратко, 1–2 предложения","bugs":["…"],"architecture":["…"],"recommendations":["…"]}',
  ].join("\n");
}

function userPrompt(input: ReviewInput, ragBlock: string): string {
  const files =
    input.files.length > 0
      ? input.files
          .slice(0, REVIEW_FILES_CAP)
          .map((f) => `- [${f.status}] ${f.path}`)
          .join("\n") + (input.files.length > REVIEW_FILES_CAP ? `\n… (+${input.files.length - REVIEW_FILES_CAP} файлов)` : "")
      : "- (список файлов пуст)";
  return [
    `Источник: ${input.source}`,
    input.title ? `Заголовок: ${input.title}` : "",
    "",
    "Изменённые файлы:",
    files,
    "",
    "Diff:",
    "```diff",
    input.diff,
    "```",
    "",
    ragBlock,
    "",
    "Проведи ревью и верни JSON по схеме из системного сообщения.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function ragBlockFrom(fragments: string[], degraded: boolean): string {
  if (degraded) {
    return "Фрагменты RAG: недоступны (сбой индекса) — ревью только по diff.";
  }
  if (fragments.length === 0) {
    return "Фрагменты RAG: релевантное не найдено — ревью по diff.";
  }
  return ["Фрагменты RAG (документация + код проекта):", ...fragments].join("\n");
}

export function renderReviewMarkdown(result: ReviewResult): string {
  const section = (title: string, items: string[]): string =>
    [`## ${title}`, ...(items.length > 0 ? items.map((t) => `- ${t}`) : ["- нет находок"])].join("\n");
  return [
    `# AI-ревью · ${result.source ?? ""}`.trimEnd(),
    "",
    `**Вердикт: ${result.verdict === "approved" ? "✅ approved" : "🚫 changes_requested"}** · модель ${result.model} · ${(result.latencyMs / 1000).toFixed(1)} с · токены ${result.usage.prompt_tokens}/${result.usage.completion_tokens}${result.truncated ? " · diff обрезан" : ""}${result.ragDegraded ? " · RAG недоступен" : ""}`,
    "",
    result.summary,
    "",
    section("Потенциальные баги", result.bugs),
    "",
    section("Архитектурные проблемы", result.architecture),
    "",
    section("Рекомендации", result.recommendations),
    "",
    section("Источники RAG", result.sources),
    "",
  ].join("\n");
}

export type ReviewService = {
  review(input: ReviewInput): Promise<ReviewResult>;
};

export function createReviewService(deps: ReviewDeps): ReviewService {
  const llm = deps.llm ?? createDeepSeekService(deps.env);
  const searcher = deps.searcher ?? createProjectSearch(deps.env);

  async function callLlm(messages: ChatMessage[]): Promise<ChatResult> {
    return llm.chat(messages, {
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 120_000,
    });
  }

  return {
    async review(input: ReviewInput): Promise<ReviewResult> {
      const started = Date.now();
      const { diff, truncated } = truncateDiff(input.diff);

      let fragments: string[] = [];
      let ragDegraded = false;
      try {
        const outcome = await runProjectSearch(buildRagQuery(input), searcher);
        // runProjectSearch глотает ошибки поиска внутрь payload.error — проверяем явно.
        if (outcome.payload.error) {
          ragDegraded = true;
          console.log(`[review] RAG недоступен, ревью по diff: ${outcome.payload.error}`);
        } else {
          fragments = outcome.payload.quotes.map(
            (q) => `- [${q.source} › ${q.section || "—"}] ${q.quote}`,
          );
        }
      } catch (error) {
        ragDegraded = true;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[review] RAG недоступен, ревью по diff: ${message}`);
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt({ ...input, diff }, ragBlockFrom(fragments, ragDegraded)) },
      ];

      let reply: ReviewReply | null = null;
      let last: ChatResult | null = null;
      let calls = 0;
      while (calls < REVIEW_MAX_LLM_CALLS) {
        calls += 1;
        last = await callLlm(messages);
        try {
          reply = parseReviewReply(last.reply);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[review] попытка ${calls}: невалидный JSON (${message})`);
          if (calls < REVIEW_MAX_LLM_CALLS) {
            messages.push({ role: "assistant", content: last.reply });
            messages.push({ role: "user", content: "Верни только валидный JSON по схеме из системного сообщения." });
          }
        }
      }
      if (!reply || !last) {
        throw new ReviewError(
          `модель не выдала валидный JSON за ${REVIEW_MAX_LLM_CALLS} попытки — последний ответ смотри выше`,
        );
      }

      return {
        source: input.source,
        ...reply,
        sources: fragments.length > 0 ? fragments : ["- (фрагменты не найдены)"],
        model: last.usage.model,
        usage: last.usage,
        latencyMs: Date.now() - started,
        truncated,
        ragDegraded,
      };
    },
  };
}
