import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { createCorpusReader } from "../services/rag/corpus.js";
import { chunkFile, endsInsideBlock, endsInsideSentence, type ChunkDraft, type RagStrategy } from "../services/rag/chunking.js";
import { createEmbedder, DEFAULT_EMBEDDINGS_MODEL, type Embedder } from "../services/rag/embeddings.js";
import { resolveFromRoot } from "../services/rag/paths.js";
import { RAG_STRATEGIES, writeJsonAtomic, type RagIndex } from "../services/rag/store.js";
import { PROBES } from "../services/rag/probes.js";

/**
 * Day21 offline build (design §3.1): corpus → 2 chunking strategies →
 * embeddings → JSON indexes in data/rag/ + comparison (structural stats +
 * RU probe retrieval, hit@1/hit@5/MRR@10 — D-4, deterministic, ₽0).
 *
 * Run: npm run rag:index  (in server/)
 * Fast tuning loop: npm run rag:index -- --compare-only — re-runs the probe
 * comparison against the EXISTING indexes (embeds 10 queries only, seconds
 * instead of minutes; keeps buildStats from the previous full build).
 *
 * Local TLS note: on this dev machine huggingface.co is TLS-intercepted
 * (self-signed corporate chain) — run with NODE_TLS_REJECT_UNAUTHORIZED=0
 * for the first (cache-warming) build; the VPS needs no such flag.
 */

interface BuildStats {
  chunks: number;
  avgChars: number;
  medianChars: number;
  p95Chars: number;
  /** Cust-fix 29.09: two honest boundary metrics (was one loose "inside sentence"). */
  splitInsideBlockPct: number;
  splitInsideSentencePct: number;
  overlapPct: number | null;
  buildTimeMs: number;
}

/** Day23 (design D-7, pass 05 F-05-2): PROBES moved to services/rag/probes.ts
 *  (single source shared with tune-rerank.ts) — importing from THIS file is
 *  forbidden for scripts: the top-level main() below would rebuild indexes. */

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function computeStats(drafts: ChunkDraft[], strategy: RagStrategy, buildTimeMs: number): BuildStats {
  const lengths = drafts.map((d) => d.text.length).sort((a, b) => a - b);
  const sum = lengths.reduce((acc, n) => acc + n, 0);
  const at = (p: number) =>
    lengths.length ? lengths[Math.min(lengths.length - 1, Math.max(0, Math.ceil((p / 100) * lengths.length) - 1))] : 0;
  const insideBlock = drafts.filter((d) => endsInsideBlock(d.text)).length;
  const insideSentence = drafts.filter((d) => endsInsideSentence(d.text)).length;
  return {
    chunks: drafts.length,
    avgChars: lengths.length ? Math.round(sum / lengths.length) : 0,
    medianChars: at(50),
    p95Chars: at(95),
    splitInsideBlockPct: lengths.length ? round4((100 * insideBlock) / lengths.length) : 0,
    splitInsideSentencePct: lengths.length ? round4((100 * insideSentence) / lengths.length) : 0,
    overlapPct: strategy === "fixed" ? 15 : null,
    buildTimeMs,
  };
}

function scoreIndex(
  queryVector: number[],
  index: RagIndex,
): { chunk: ChunkDraft & { vector: number[] }; score: number }[] {
  const scored = index.chunks.map((chunk) => {
    let score = 0;
    for (let i = 0; i < index.dim; i++) score += queryVector[i] * chunk.vector[i];
    return { chunk: chunk as ChunkDraft & { vector: number[] }, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function runProbeComparison(
  indexes: Map<RagStrategy, RagIndex>,
  embedder: Embedder,
): Promise<{
  byStrategy: Record<RagStrategy, { hitAt1: number; hitAt5: number; mrr: number }>;
  probeRows: string[];
}> {
  const byStrategy = {} as Record<RagStrategy, { hitAt1: number; hitAt5: number; mrr: number }>;
  const probeRows: string[] = [];
  for (const strategy of RAG_STRATEGIES) {
    const index = indexes.get(strategy);
    if (!index) throw new Error(`index ${strategy} missing`);
    let hit1 = 0;
    let hit5 = 0;
    let rrSum = 0;
    for (const probe of PROBES) {
      const qvec = await embedder.embedQuery(probe.q);
      const ranked = scoreIndex(qvec, index);
      const rank =
        ranked.findIndex((r) => probe.expectSources.includes(r.chunk.source)) + 1;
      if (rank === 1) hit1++;
      if (rank >= 1 && rank <= 5) hit5++;
      if (rank >= 1 && rank <= 10) rrSum += 1 / rank;
      probeRows.push(
        `[${strategy}] "${probe.q}" → ${rank > 0 ? `rank ${rank}` : "not in top-10"} (expect ${probe.expectSources.join(" | ")})`,
      );
    }
    byStrategy[strategy] = {
      hitAt1: round4(hit1 / PROBES.length),
      hitAt5: round4(hit5 / PROBES.length),
      mrr: round4(rrSum / PROBES.length),
    };
  }
  return { byStrategy, probeRows };
}

function printReport(
  buildStats: Record<RagStrategy, BuildStats> | null,
  byStrategy: Record<RagStrategy, { hitAt1: number; hitAt5: number; mrr: number }>,
  probeRows: string[],
): void {
  console.log(`\n[rag] probe retrieval (${PROBES.length} RU probes, expected source = file-level):`);
  for (const row of probeRows) console.log("  " + row);
  console.log("\n[rag] сравнение стратегий чанкинга:");
  console.table(
    RAG_STRATEGIES.map((strategy) => ({
      стратегия: strategy,
      чанков: buildStats?.[strategy].chunks ?? "—",
      "avg симв": buildStats?.[strategy].avgChars ?? "—",
      "медиана": buildStats?.[strategy].medianChars ?? "—",
      "p95": buildStats?.[strategy].p95Chars ?? "—",
      "разрезов в блоке %": buildStats?.[strategy].splitInsideBlockPct ?? "—",
      "разрезов в предложении %": buildStats?.[strategy].splitInsideSentencePct ?? "—",
      "overlap %": buildStats?.[strategy].overlapPct ?? "—",
      "hit@1": byStrategy[strategy].hitAt1,
      "hit@5": byStrategy[strategy].hitAt5,
      "MRR@10": byStrategy[strategy].mrr,
      "сборка мс": buildStats?.[strategy].buildTimeMs ?? "—",
    })),
  );
  const better = byStrategy.fixed.mrr >= byStrategy.structured.mrr ? "fixed" : "structured";
  console.log(
    `[rag] вывод: по пробному ретриву лучше «${better}» (MRR ${byStrategy[better].mrr} vs ${byStrategy[better === "fixed" ? "structured" : "fixed"].mrr}); детали — в NOTES.`,
  );
}

async function main(): Promise<void> {
  const env = loadEnv();
  const model = env.RAG_EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDINGS_MODEL;
  const indexDir = resolveFromRoot(env.RAG_INDEX_DIR, "data/rag");
  const compareOnly = process.argv.includes("--compare-only");

  if (compareOnly) {
    // Fast path: existing indexes + 10 query embeddings (seconds, ₽0).
    const indexes = new Map<RagStrategy, RagIndex>();
    for (const strategy of RAG_STRATEGIES) {
      const raw = await fs.readFile(path.join(indexDir, `rag-index-${strategy}.json`), "utf8");
      indexes.set(strategy, JSON.parse(raw) as RagIndex);
    }
    const embedder = await createEmbedder(env, model);
    const { byStrategy, probeRows } = await runProbeComparison(indexes, embedder);
    let buildStats: Record<RagStrategy, BuildStats>;
    try {
      buildStats = (JSON.parse(await fs.readFile(path.join(indexDir, "compare-stats.json"), "utf8"))).buildStats;
    } catch {
      throw new Error("compare-only: нет прошлого compare-stats.json — сначала полный прогон rag:index");
    }
    const compareStats = {
      generatedAt: new Date().toISOString(),
      model,
      probes: PROBES.length,
      byStrategy,
      buildStats,
    };
    await writeJsonAtomic(path.join(indexDir, "compare-stats.json"), compareStats);
    printReport(buildStats, byStrategy, probeRows);
    return;
  }

  console.log(`[rag] corpus: reading…`);
  const files = await createCorpusReader().readAll();
  console.log(`[rag] corpus: ${files.length} files, ${files.reduce((a, f) => a + f.text.length, 0)} chars`);

  const embedder = await createEmbedder(env, model);
  const indexes = new Map<RagStrategy, RagIndex>();
  const buildStats = {} as Record<RagStrategy, BuildStats>;

  for (const strategy of RAG_STRATEGIES) {
    const t0 = Date.now();
    const drafts = files.flatMap((f) => chunkFile(f, strategy));
    const stats = computeStats(drafts, strategy, Date.now() - t0);
    buildStats[strategy] = stats;
    console.log(
      `[rag/${strategy}] ${stats.chunks} chunks · avg ${stats.avgChars} · median ${stats.medianChars} · p95 ${stats.p95Chars} · inside-block ${stats.splitInsideBlockPct}% · inside-sentence ${stats.splitInsideSentencePct}%`,
    );

    console.log(`[rag/${strategy}] embedding ${drafts.length} chunks with ${model}…`);
    const vectors = await embedder.embedPassages(
      drafts.map((d) => d.text),
      (done, total) => {
        if (done % 128 === 0 || done === total) console.log(`[rag/${strategy}] ${done}/${total}`);
      },
    );
    const index: RagIndex = {
      model,
      dim: vectors[0]?.length ?? 0,
      strategy,
      builtAt: new Date().toISOString(),
      chunks: drafts.map((d, i) => ({ ...d, vector: vectors[i].map(round4) })),
    };
    await writeJsonAtomic(path.join(indexDir, `rag-index-${strategy}.json`), index);
    indexes.set(strategy, index);
    console.log(`[rag/${strategy}] index written (${(Date.now() - t0) / 1000}s total)`);
  }

  const { byStrategy, probeRows } = await runProbeComparison(indexes, embedder);
  const compareStats = {
    generatedAt: new Date().toISOString(),
    model,
    probes: PROBES.length,
    byStrategy,
    buildStats,
  };
  await writeJsonAtomic(path.join(indexDir, "compare-stats.json"), compareStats);
  printReport(buildStats, byStrategy, probeRows);
}

main().catch((err) => {
  console.error("[rag] build failed:", err);
  process.exit(1);
});
