import path from "node:path";
import { loadEnv } from "../config/env.js";
import { PROBES } from "../services/rag/probes.js";
import { repoRoot } from "../services/rag/paths.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";

/**
 * Day24 dontKnow-gate tune (design D-4, Δ-4): cosine top-1 sweep over the 12
 * on-corpus probes + 5 off-corpus probes (near-miss distractors included —
 * «массаж спины»/«растяжка спины» — не только дальний домен: низкий косинус
 * ≠ off-corpus, порог обязан пройти через near-miss'ы).
 *
 *   npm run rag:tune    (цепочка: tune-dontknow ПЕРВЫМ, затем tune-rerank —
 *                       локальные эмбеддинги, ₽0, без реранкера и 544 МиБ;
 *                       свежая машина получает порог даже при падении свипа)
 *
 * Порог (гейт-D-7): зазор есть (min on-corpus top-1 > max off-corpus top-1)
 * → середина зазора; зазора нет → консервативный порог чуть ниже min
 * on-corpus top-1 (ни одна on-corpus проба не падает в «не знаю») + честная
 * запись в артефакт. Артефакт data/rag/tune-dontknow.json коммитится —
 * ask-гейт (answer.ts) читает порог per-read.
 */

const STRATEGY = "structured" as const;
/** Консервативный отступ (гейт-D-7): порог ниже min on-corpus top-1. */
const CONSERVATIVE_MARGIN = 0.01;

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

interface SweepRow {
  id: string;
  kind: "onCorpus" | "offCorpus";
  q: string;
  topCosine: number;
}

async function main(): Promise<number> {
  const env = loadEnv();
  const rag = createRagService(env);
  const onCorpusCount = PROBES.filter((p) => p.kind !== "offCorpus").length;
  const offCorpusCount = PROBES.length - onCorpusCount;
  console.log(
    `[rag:tune] dontknow-свип: ${onCorpusCount} on-corpus + ${offCorpusCount} off-corpus проб · стратегия ${STRATEGY} · локальные эмбеддинги (₽0)`,
  );

  const rows: SweepRow[] = [];
  let onN = 0;
  let offN = 0;
  for (const probe of PROBES) {
    const kind = probe.kind === "offCorpus" ? "offCorpus" : "onCorpus";
    const n = kind === "offCorpus" ? ++offN : ++onN;
    const { hits } = await rag.rankAll(probe.q, STRATEGY);
    const topCosine = round4(hits[0]?.score ?? 0);
    rows.push({
      id: `${kind === "offCorpus" ? "off" : "on"}-${String(n).padStart(2, "0")}`,
      kind,
      q: probe.q,
      topCosine,
    });
    console.log(`[rag:tune] [${kind}] "${probe.q.slice(0, 48)}" top-1 косинус ${topCosine}`);
  }

  const onScores = rows.filter((r) => r.kind === "onCorpus").map((r) => r.topCosine);
  const offScores = rows.filter((r) => r.kind === "offCorpus").map((r) => r.topCosine);
  const onMin = onScores.length ? Math.min(...onScores) : 0;
  const offMax = offScores.length ? Math.max(...offScores) : 0;
  const gapOk = onScores.length > 0 && offScores.length > 0 && onMin > offMax;
  const value = gapOk
    ? round4((onMin + offMax) / 2)
    : Math.max(0, round4(onMin - CONSERVATIVE_MARGIN));
  const kind = gapOk ? "gap-midpoint" : "conservative";
  const rationale = gapOk
    ? `зазор есть: min on-corpus top-1 ${onMin} > max off-corpus top-1 ${offMax} (зазор ${round4(onMin - offMax)}) → порог — середина зазора`
    : `зазора нет: min on-corpus top-1 ${onMin} ≤ max off-corpus top-1 ${offMax} (near-miss дистрактор выше) → консервативный порог min on-corpus − ${CONSERVATIVE_MARGIN}: ни одна on-corpus проба не падает в «не знаю» (гейт-D-7); off-corpus near-miss может проходить выше порога — задокументировано в NOTES`;

  const artifact = {
    builtAt: new Date().toISOString(),
    probes: rows,
    onMin,
    offMax,
    gapOk,
    threshold: { value, kind },
    rationale,
  };
  await writeJsonAtomic(path.join(repoRoot, "data", "rag", "tune-dontknow.json"), artifact);

  console.table(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      запрос: r.q.slice(0, 40),
      "top-1 косинус": r.topCosine,
    })),
  );
  console.log(
    `[rag:tune] dontknow: onMin ${onMin} · offMax ${offMax} · gapOk ${gapOk} → порог ${value} (${kind})`,
  );
  console.log(
    "[rag:tune] артефакт: data/rag/tune-dontknow.json (коммитится — ask-гейт читает порог из него)",
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[rag:tune] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
