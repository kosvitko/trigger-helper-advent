import path from "node:path";
import { loadEnv } from "../config/env.js";
import { PROBES } from "../services/rag/probes.js";
import { createRerankScorer } from "../services/rag/rerank.js";
import { repoRoot } from "../services/rag/paths.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";

/**
 * Day23 tune (design D-3/D-7): measures the LOCAL cross-encoder on the 12
 * card-corpus probes (NOT the 10 control questions — test set, F-1) and pins
 * the threshold + pool the rerank arms use (rerank.ts reads this artifact).
 *
 *   npm run rag:tune
 *
 * No LLM, no ledger → no race with a live server (F-05-2 applies to rag:eval,
 * not here). First run downloads ~544 MiB of ONNX weights: on this dev machine
 * run with NODE_TLS_REJECT_UNAUTHORIZED=0 in the session env (TLS interception
 * precedent: build-rag-index.ts:20–22); the VPS needs no flag but pays the
 * download on the first request (design D-11 warm-up).
 *
 * Honesty note (pass 02 F-1): probes and control questions overlap
 * (paraphrases) — the threshold is chosen from the expected-vs-distractor
 * score DISTRIBUTION only; NOTES phrases the eval set as "контрольные,
 * частично пересекающиеся с пробами", never as an independent test set.
 */

const POOL = 40;
const STRATEGY = "structured" as const;

interface ProbeRow {
  q: string;
  expectSources: string[];
  cosineRank: number | null;
  rerankRank: number | null;
  expectedScores: number[];
  distractorMax: number;
  distractorTopScores: number[];
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const rag = createRagService(env);
  const scorer = await createRerankScorer(env);
  console.log(
    `[rag:tune] модель ${scorer.model} · пул ${POOL} · стратегия ${STRATEGY} · проб ${PROBES.length}`,
  );

  const rows: ProbeRow[] = [];
  const bestExpected: number[] = [];
  const maxDistractors: number[] = [];
  let totalMs = 0;
  let batches = 0;

  for (const probe of PROBES) {
    const { hits } = await rag.rankAll(probe.q, STRATEGY);
    const poolHits = hits.slice(0, POOL);
    const cosineRank = poolHits.findIndex((h) => probe.expectSources.includes(h.chunk.source)) + 1;

    const t0 = Date.now();
    const scores = await scorer.scoreAll(probe.q, poolHits.map((h) => h.chunk.text));
    const dt = Date.now() - t0;
    totalMs += dt;
    batches += Math.ceil(poolHits.length / 8);

    const scored = poolHits
      .map((hit, i) => ({ hit, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score);
    const rerankRank = scored.findIndex((s) => probe.expectSources.includes(s.hit.chunk.source)) + 1;
    const expected = scored.filter((s) => probe.expectSources.includes(s.hit.chunk.source));
    const distractors = scored.filter((s) => !probe.expectSources.includes(s.hit.chunk.source));
    const expectedScores = expected.map((s) => round4(s.score));
    const distractorMax = distractors.length ? round4(distractors[0].score) : 0;

    if (expectedScores.length > 0 && distractors.length > 0) {
      bestExpected.push(Math.max(...expectedScores));
      maxDistractors.push(distractorMax);
    }
    rows.push({
      q: probe.q,
      expectSources: probe.expectSources,
      cosineRank: cosineRank > 0 ? cosineRank : null,
      rerankRank: rerankRank > 0 ? rerankRank : null,
      expectedScores,
      distractorMax,
      distractorTopScores: distractors.slice(0, 3).map((s) => round4(s.score)),
    });
    console.log(
      `[rag:tune] "${probe.q.slice(0, 48)}…" косинус ${cosineRank > 0 ? cosineRank : "∉пул"} → реранк ${rerankRank > 0 ? rerankRank : "∉пул"} · ожид ${expectedScores.join("/") || "—"} · дистрактор max ${distractorMax}`,
    );
  }

  const minExpected = bestExpected.length ? round4(Math.min(...bestExpected)) : 0;
  const maxDistractor = maxDistractors.length ? round4(Math.max(...maxDistractors)) : 0;
  const gapOk = bestExpected.length > 0 && minExpected > maxDistractor;
  // D-3 ladder: rung 1 = absolute sigmoid (only with a proven global gap);
  // rung 2 (this run) = relative margin top1 − value, per-query scale varies
  // too much for a global absolute cutoff (measured: minExpected 0.018 vs
  // maxDistractor 0.955). Margin 0.05 keeps every probe's expected chunk in
  // the observed gaps {0; 0.049; 0.133-excluded-by-design} — a precision trim,
  // not a recall tool (the red-team monotonicity framing).
  const value = 0.05;
  const kind = gapOk ? "absolute-sigmoid" : "relative-margin";
  const absoluteValue = gapOk ? Math.round(((minExpected + maxDistractor) / 2) * 100) / 100 : value;
  const rationale = gapOk
    ? `зазор ${round4(minExpected - maxDistractor)} между худшим ожидаемым и лучшим дистрактором (пул ${POOL}) → абсолютный порог`
    : `глобального зазора нет (minExpected ${minExpected} ≤ maxDistractor ${maxDistractor}) → D-3 рунг 2: относительная маржа top1 − ${value}; точечная обрезка, не рычаг полноты`;

  const perBatch = batches ? Math.round(totalMs / batches) : 0;
  const perPool = PROBES.length ? Math.round(totalMs / PROBES.length) : 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    model: scorer.model,
    pool: POOL,
    threshold: { value: absoluteValue, kind, rationale },
    probes: rows,
    separation: { minExpected, maxDistractor, gapOk },
    rerankLatencyMs: { perBatch, perPool },
  };
  await writeJsonAtomic(path.join(repoRoot, "data", "rag", "tune-rerank.json"), artifact);

  console.table(
    rows.map((r) => ({
      запрос: r.q.slice(0, 40),
      косинус: r.cosineRank ?? "∉",
      реранк: r.rerankRank ?? "∉",
      "ожид. скор": r.expectedScores.join("/"),
      "дистр. max": r.distractorMax,
    })),
  );
  console.log(
    `[rag:tune] зазор: minExpected ${minExpected} · maxDistractor ${maxDistractor} · gapOk ${gapOk} → порог ${value} (${rationale})`,
  );
  console.log(`[rag:tune] латентность: ~${perBatch} мс/батч · ~${(perPool / 1000).toFixed(1)} s/пул (локально)`);
  console.log("[rag:tune] артефакт: data/rag/tune-rerank.json (коммитится — rerank-arms читают порог из него)");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[rag:tune] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
