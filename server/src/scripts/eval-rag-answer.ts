import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { createDeepSeekService } from "../services/deepseek.js";
import { createUsageLedgerService } from "../services/usage-ledger.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";
import { repoRoot } from "../services/rag/paths.js";
import { createRagAnswerService, type RagAskResult } from "../services/rag/answer.js";
import { createReranker } from "../services/rag/rerank.js";
import { createRewriteQueries } from "../services/rag/rewrite.js";
import { getBudgetSnapshot } from "../services/cost-aware-throttle.js";

/**
 * Day23 answer-level eval (design D-6): the 10 control questions × 4 rag
 * arms (base / rerank / rewrite / full) — deterministic scoring, no LLM
 * judge. The day-22 baseline is NOT re-run (gate D-1): its committed
 * aggregate is lifted into aggregate.anchorDay22 before the write (F-05-3).
 *
 *   npm run rag:eval    (run rag:tune first — rerank arms need the artifact)
 *
 * Reads data/rag/eval-questions.json, calls RagAnswerService directly
 * (no HTTP, no rate-limit; budget ceiling NOT enforced on this path — F-B2 —
 * warn-only snapshot below), writes data/rag/eval-answers.json (v2: stage +
 * rewrite_tokens per row, aggregate.byStage) and prints the matrix table.
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

/** Day23 arms (design D-5): the rag-stage matrix. Baseline is not re-run —
 *  the day-22 committed aggregate rides along as the anchor (gate D-1). */
const STAGES = [
  { stage: "base", rerank: false, rewrite: false },
  { stage: "rerank", rerank: true, rewrite: false },
  { stage: "rewrite", rerank: false, rewrite: true },
  { stage: "full", rerank: true, rewrite: true },
] as const;

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
  /** Day23 eval arm (design D-5); baseline rows are not re-run (anchor). */
  stage: string;
  answer: string;
  sourcesUsed: string[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Rewrite share of usage.total_tokens (F-04-5: usage is summed). */
  rewriteTokens: number;
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
  // F-04-1: the eval script builds the SAME deps as index.ts — rerank arms
  // additionally require the committed tune artifact (order: tune → eval).
  const service = createRagAnswerService({
    rag,
    deepSeek,
    ledger,
    reranker: createReranker(env),
    rewriter: createRewriteQueries(deepSeek),
  });

  // Warn-only budget snapshot (F-B2): the run bypasses the route throttle.
  const budget = await getBudgetSnapshot(ledger, env);
  console.log(
    "[rag:eval] бюджет дня: использовано ₽" + String(budget.used_rub) + " из ₽" + String(budget.limit_rub) +
      " · прогон ~40 вызовов deepseek-chat ≈ ₽4",
  );
  if (budget.remaining_rub !== null && budget.remaining_rub < 5) {
    console.warn(`[rag:eval] ВНИМАНИЕ: остаток дня ₽${budget.remaining_rub} — может не хватить на прогон`);
  }
  console.log(
    "[rag:eval] ledger — единый писатель: сервер должен быть остановлен (F-05-2), иначе записи могут потеряться",
  );

  const rows: Row[] = [];
  for (const question of questions) {
    for (const arm of STAGES) {
      process.stdout.write(`[rag:eval] ${question.id} ${arm.stage} … `);
      try {
        const result = await service.ask({
          q: question.q,
          mode: "rag",
          strategy: STRATEGY,
          k: K,
          rerank: arm.rerank,
          rewrite: arm.rewrite,
        });
        const scores = scoreAnswer(result.answer, question, result);
        const rewriteTokens = result.meta.rewrite?.tokens ?? 0;
        rows.push({
          id: question.id,
          q: question.q,
          stage: arm.stage,
          answer: result.answer,
          sourcesUsed: result.sources.map((s) => s.chunk_id),
          usage: {
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          },
          rewriteTokens,
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
          stage: arm.stage,
          answer: `(error) ${err instanceof Error ? err.message : String(err)}`,
          sourcesUsed: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          rewriteTokens: 0,
          latencyMs: 0,
          scores: { content: 0, retrieval: false, grounding: false },
          verdict: "FAIL",
        });
      }
    }
  }

  const byStage: Record<string, ReturnType<typeof summarize>> = {};
  for (const { stage } of STAGES) byStage[stage] = summarize(rows.filter((r) => r.stage === stage));
  // Anchor lift (F-05-3): this run OVERWRITES the only in-repo copy of the
  // day-22 baseline aggregate — lift it BEFORE writing (idempotent: later runs
  // carry the already-lifted anchorDay22 forward as-is).
  let anchorDay22: unknown = null;
  try {
    const existing = JSON.parse(await fs.readFile(path.join(repoRoot, OUT_FILE), "utf8")) as {
      aggregate?: { anchorDay22?: unknown; byMode?: { baseline?: unknown } };
    };
    anchorDay22 = existing.aggregate?.anchorDay22 ?? existing.aggregate?.byMode?.baseline ?? null;
  } catch {
    anchorDay22 = null; // no committed predecessor — nothing to lift
  }
  const artifact = {
    generatedAt: new Date().toISOString(),
    model: parsed.data.model,
    strategy: STRATEGY,
    k: K,
    // Day23 v2: stage arms; usage is the FULL price (answer + rewrite summed,
    // F-04-5) — rewrite_tokens splits the rewrite share back out.
    questions: rows.map((r) => {
      const question = questions.find((qq) => qq.id === r.id);
      return {
        id: r.id,
        q: r.q,
        stage: r.stage,
        answer: r.answer,
        // chunk_id strings of the injected context (F-B3)
        sourcesUsed: r.sourcesUsed,
        // Cost of access is mandatory in the comparison (решение Кости 30.09)
        usage: r.usage,
        rewrite_tokens: r.rewriteTokens,
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
      byStage,
      retrievalHitRate: rate(rows.map((r) => r.scores.retrieval)),
      groundingRate: rate(rows.map((r) => r.scores.grounding)),
      anchorDay22,
    },
  };

  await writeJsonAtomic(path.join(repoRoot, OUT_FILE), artifact);

  console.log("\n[rag:eval] матрица (этап · контент / цена доступа: токены · время):");
  console.table(
    rows.map((r) => ({
      id: r.id,
      stage: r.stage,
      content: r.scores.content.toFixed(2),
      verdict: r.verdict,
      retrieval: r.scores.retrieval === null ? "—" : r.scores.retrieval ? "✓" : "✗",
      grounding: r.scores.grounding === null ? "—" : r.scores.grounding ? "✓" : "✗",
      tokens: r.usage.total_tokens,
      "из них rewrite": r.rewriteTokens || "—",
      ms: r.latencyMs,
    })),
  );
  for (const { stage } of STAGES) {
    const s = byStage[stage];
    console.log(
      `[rag:eval] ${stage}: PASS ${s.pass}/${s.total} · mean ${s.meanContent.toFixed(2)}` +
        ` · ~${Math.round(s.meanTokens)} tok · ${(s.meanLatencyMs / 1000).toFixed(1)} s` +
        ` · retrieval ${rate(rows.filter((r) => r.stage === stage).map((r) => r.scores.retrieval)).toFixed(2)}`,
    );
  }
  const base = byStage.base;
  const best = STAGES.map(({ stage }) => ({ stage, s: byStage[stage] })).sort(
    (a, b) => b.s.meanContent - a.s.meanContent,
  )[0];
  const win =
    best.stage !== "base" &&
    best.s.meanContent > base.meanContent &&
    best.s.pass >= base.pass &&
    best.s.meanTokens <= base.meanTokens * 1.15;
  console.log(
    `[rag:eval] вывод: лучший arm «${best.stage}» ${best.s.meanContent.toFixed(2)} vs base ${base.meanContent.toFixed(2)} — ` +
      (win
        ? "критерий победы выполнен; решение о дефолте — гейт с Костей по артефакту (D-5)"
        : "критерий победы НЕ выполнен — дефолт не меняем (D-5)"),
  );
  console.log(
    "[rag:eval] анкер дня 22 (baseline, из прошлого артефакта): " +
      (anchorDay22 ? JSON.stringify(anchorDay22) : "нет"),
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
