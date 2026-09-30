import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { createDeepSeekService } from "../services/deepseek.js";
import { createUsageLedgerService } from "../services/usage-ledger.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";
import { repoRoot } from "../services/rag/paths.js";
import { createRagAnswerService, type RagAskResult } from "../services/rag/answer.js";
import { getBudgetSnapshot } from "../services/cost-aware-throttle.js";

/**
 * Day22 answer-level eval (design D-8/D-14): 10 control questions × 2 modes
 * (baseline | rag), scored deterministically — no LLM judge (gate D-6).
 *
 *   npm run rag:eval
 *
 * Reads data/rag/eval-questions.json, calls RagAnswerService directly
 * (no HTTP, no rate-limit; budget ceiling NOT enforced on this path — F-B2 —
 * warn-only snapshot below), writes data/rag/eval-answers.json and prints the
 * 10×2 verdict table.
 *
 * ⚠ Ledger single-writer (F-05-2): UsageLedgerService is read-modify-write of
 * one JSON with an in-process cache — run this with the server STOPPED, or
 * records may be silently lost.
 *
 * Scoring (D-8): content = normalized contains-checks of must-mention items
 * (PASS ≥ 0.8 / PARTIAL > 0 / FAIL = 0); retrieval = any expected source in
 * the injected top-k (rag rows only); grounding = normalized answer contains
 * an expected source path or basename (rag rows only). Baseline rows carry
 * retrieval/grounding = null (F-05-4).
 */

/** Day22: canonical eval config = structured + k=12 (замер 30.09 — лучший
 *  ответ-уровень; вопрос Кости «почему не structured?» подтверждён замером).
 *  Флаги --strategy/--k/--out остаются для A/B. */
const STRATEGY = (process.argv.find((a) => a.startsWith("--strategy="))?.split("=")[1] ??
  "structured") as "fixed" | "structured";
const OUT_FILE =
  process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "data/rag/eval-answers.json";
/** k — нормируется по объёму контекста (structured чанки мельче → k больше). */
const K = Number(process.argv.find((a) => a.startsWith("--k="))?.split("=")[1] ?? 12);

const questionSchema = z.object({
  id: z.string().min(1),
  q: z.string().min(1),
  expectation: z.array(z.string().min(1)).min(1),
  sources: z.array(z.string().min(1)),
});

const evalQuestionsSchema = z.object({
  generatedAt: z.string().min(1),
  model: z.string().min(1),
  questions: z.array(questionSchema).min(1),
});

type EvalQuestion = z.infer<typeof questionSchema>;
type Score = { content: number; retrieval: boolean | null; grounding: boolean | null };
type Row = {
  id: string;
  q: string;
  mode: "baseline" | "rag";
  answer: string;
  sourcesUsed: string[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  latencyMs: number;
  scores: Score;
  verdict: "PASS" | "PARTIAL" | "FAIL";
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(normalize(n)));
}

function scoreAnswer(
  answer: string,
  question: EvalQuestion,
  result: RagAskResult,
): Score {
  const norm = normalize(answer);
  const hits = question.expectation.filter((e) => norm.includes(normalize(e))).length;
  const content = hits / question.expectation.length;
  if (result.mode !== "rag") {
    return { content, retrieval: null, grounding: null };
  }
  const injected = result.sources.map((s) => s.source);
  const retrieval = question.sources.some((s) => injected.includes(s));
  const baseNames = question.sources.flatMap((s) => [
    path.basename(s),
    path.basename(s).replace(/\.md$/i, ""),
  ]);
  const grounding = containsAny(answer, baseNames);
  return { content, retrieval, grounding };
}

function verdictOf(content: number): "PASS" | "PARTIAL" | "FAIL" {
  if (content >= 0.8) return "PASS";
  if (content > 0) return "PARTIAL";
  return "FAIL";
}

async function main(): Promise<number> {
  const env = loadEnv();
  const questionsPath = path.join(repoRoot, "data/rag/eval-questions.json");
  const raw = JSON.parse(await fs.readFile(questionsPath, "utf8"));
  const parsed = evalQuestionsSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[rag:eval] eval-questions.json schema mismatch: ${parsed.error.message}`);
    return 1;
  }
  const questions = parsed.data.questions;

  const rag = createRagService(env);
  const deepSeek = createDeepSeekService(env);
  const ledger = createUsageLedgerService(env.USAGE_FILE);
  const service = createRagAnswerService({ rag, deepSeek, ledger });

  // Warn-only budget snapshot (F-B2): the run bypasses the route throttle.
  const budget = await getBudgetSnapshot(ledger, env);
  console.log(
    `[rag:eval] бюджет дня: использовано ₽${budget.used_rub} из ₽${budget.limit_rub}` +
      ` · прогон ~20 вызовов deepseek-chat ≈ ₽2`,
  );
  if (budget.remaining_rub !== null && budget.remaining_rub < 5) {
    console.warn(`[rag:eval] ВНИМАНИЕ: остаток дня ₽${budget.remaining_rub} — может не хватить на прогон`);
  }
  console.log(
    "[rag:eval] ledger — единый писатель: сервер должен быть остановлен (F-05-2), иначе записи могут потеряться",
  );

  const rows: Row[] = [];
  for (const question of questions) {
    for (const mode of ["baseline", "rag"] as const) {
      process.stdout.write(`[rag:eval] ${question.id} ${mode} … `);
      try {
        const result = await service.ask({
          q: question.q,
          mode,
          strategy: STRATEGY,
          k: K,
        });
        const scores = scoreAnswer(result.answer, question, result);
        rows.push({
          id: question.id,
          q: question.q,
          mode,
          answer: result.answer,
          sourcesUsed: result.sources.map((s) => s.chunk_id),
          usage: {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          },
          latencyMs: result.meta.latencyMs,
          scores,
          verdict: verdictOf(scores.content),
        });
        console.log(`${scores.content.toFixed(2)} → ${verdictOf(scores.content)}`);
      } catch (err) {
        console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        rows.push({
          id: question.id,
          q: question.q,
          mode,
          answer: `(error) ${err instanceof Error ? err.message : String(err)}`,
          sourcesUsed: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latencyMs: 0,
          scores: { content: 0, retrieval: mode === "rag" ? false : null, grounding: mode === "rag" ? false : null },
          verdict: "FAIL",
        });
      }
    }
  }

  const byMode = {
    baseline: summarize(rows.filter((r) => r.mode === "baseline")),
    rag: summarize(rows.filter((r) => r.mode === "rag")),
  };
  const ragRows = rows.filter((r) => r.mode === "rag");
  const artifact = {
    generatedAt: new Date().toISOString(),
    model: parsed.data.model,
    strategy: STRATEGY,
    k: K,
    questions: rows.map((r) => {
      const question = questions.find((qq) => qq.id === r.id);
      return {
        id: r.id,
        q: r.q,
        mode: r.mode,
        answer: r.answer,
        // chunk_id strings of the injected context / read cards (F-B3); baseline: []
        sourcesUsed: r.sourcesUsed,
        // Cost of access is mandatory in the comparison (решение Кости 30.09)
        usage: r.usage,
        latency_ms: r.latencyMs,
        scores: r.scores,
        verdict: r.verdict,
        // The metric construction stays visible (D-14, правка Кости 30.09):
        // every row carries its question's expectation + expected sources.
        expectation: question?.expectation ?? [],
        sources: question?.sources ?? [],
      };
    }),
    aggregate: {
      byMode,
      retrievalHitRate: rate(ragRows.map((r) => r.scores.retrieval)),
      groundingRate: rate(ragRows.map((r) => r.scores.grounding)),
    },
  };

  await writeJsonAtomic(path.join(repoRoot, OUT_FILE), artifact);

  console.log("\n[rag:eval] таблица 10×2 (контент / цена доступа: токены · время):");
  console.table(
    rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      content: r.scores.content.toFixed(2),
      verdict: r.verdict,
      retrieval: r.scores.retrieval === null ? "—" : r.scores.retrieval ? "✓" : "✗",
      grounding: r.scores.grounding === null ? "—" : r.scores.grounding ? "✓" : "✗",
      tokens: r.usage.total_tokens,
      ms: r.latencyMs,
    })),
  );
  console.log(
    `[rag:eval] агрегат: baseline PASS ${byMode.baseline.pass}/${byMode.baseline.total}` +
      ` · rag PASS ${byMode.rag.pass}/${byMode.rag.total}` +
      ` · meanContent ${byMode.baseline.meanContent.toFixed(2)} → ${byMode.rag.meanContent.toFixed(2)}` +
      ` · retrieval ${artifact.aggregate.retrievalHitRate.toFixed(2)} · grounding ${artifact.aggregate.groundingRate.toFixed(2)}`,
  );
  console.log(
    `[rag:eval] цена доступа: baseline ~${Math.round(byMode.baseline.meanTokens)} tok / ` +
      `${(byMode.baseline.meanLatencyMs / 1000).toFixed(1)} s  →  ` +
      `rag ~${Math.round(byMode.rag.meanTokens)} tok / ${(byMode.rag.meanLatencyMs / 1000).toFixed(1)} s`,
  );
  const ragBetter = byMode.rag.meanContent > byMode.baseline.meanContent;
  console.log(
    `[rag:eval] вывод: RAG ${ragBetter ? "повышает" : "НЕ повышает"} качество ответов` +
      ` (${byMode.baseline.meanContent.toFixed(2)} → ${byMode.rag.meanContent.toFixed(2)});` +
      ` ретрив попадает в ожидаемый источник в ${Math.round(artifact.aggregate.retrievalHitRate * 100)}% вопросов` +
      ` · базлайн дешевле/быстрее в ${Math.max(1, Math.round(byMode.baseline.meanTokens / Math.max(1, byMode.rag.meanTokens)))}× по токенам` +
      `, время — см. строку выше`,
  );
  console.log("[rag:eval] артефакт: " + OUT_FILE);
  return 0;
}

function summarize(rows: Row[]) {
  const total = rows.length;
  const pass = rows.filter((r) => r.verdict === "PASS").length;
  const partial = rows.filter((r) => r.verdict === "PARTIAL").length;
  const fail = rows.filter((r) => r.verdict === "FAIL").length;
  const meanContent = total ? rows.reduce((acc, r) => acc + r.scores.content, 0) / total : 0;
  const meanTokens = total ? rows.reduce((acc, r) => acc + r.usage.total_tokens, 0) / total : 0;
  const meanLatencyMs = total ? rows.reduce((acc, r) => acc + r.latencyMs, 0) / total : 0;
  return { total, pass, partial, fail, meanContent, meanTokens, meanLatencyMs };
}

function rate(values: (boolean | null)[]): number {
  const vals = values.filter((v): v is boolean => v !== null);
  return vals.length ? vals.filter(Boolean).length / vals.length : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[rag:eval] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
