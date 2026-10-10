import fs from "node:fs/promises";
import path from "node:path";
import type { LlmUsage } from "@trigger-helper/shared";
import { loadEnv } from "../config/env.js";
import { createDeepSeekService } from "../services/deepseek.js";
import { createUsageLedgerService } from "../services/usage-ledger.js";
import {
  chatLocalLlm,
  isLocalCatalogId,
  LOCAL_LLM_SYSTEM_PROMPT,
  localRagRetrieve,
  probeLocalLlm,
} from "../services/local-llm.js";
import { repoRoot } from "../services/rag/paths.js";
import { createReranker } from "../services/rag/rerank.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";
import { normalizeRu } from "../services/rag/text.js";

/**
 * День 28 — сравнение локальной vs облачной генерации поверх ОДНОГО
 * retrieval (proposals 261009 §3.1-4). Задание дня: RAG полностью локально +
 * сравнить качество/скорость/стабильность.
 *
 *   npm run rag:compare                          (8 вопросов × 2 прогона × 2 арма)
 *   npm run rag:compare -- --limit=2 --runs=1    (смок)
 *   npm run rag:compare -- --report              (таблица агрегата из ГОТОВОГО
 *           артефакта data/rag/compare-local.json без пересчёта; нет
 *           артефакта — ясная ошибка и exit 1; сцена 4 скринкаста дня 28)
 *
 * Поток на вопрос: retrieval ОДИН РАЗ (localRagRetrieve — тот же конвейер,
 * что локальная ветка /api/chat, БЕЗ dontKnow-гейта: что вернул поиск — то и
 * в контексте) → два генератора с ОДИНАКОВЫМ промптом (LOCAL_LLM_SYSTEM_PROMPT
 * + SEC-F3-контекст — так строит system chatLocalLlm) — армы отличаются
 * только генератором:
 *   local — qwen2.5:1.5b через chatLocalLlm (num_ctx 2048, температура
 *           рантайма по умолчанию — параметры не настраиваем, это день 29);
 *   cloud — дефолтная free deepseek (env.DEEPSEEK_MODEL) прямым chat(),
 *           plain text без jsonMode (рельса AGENTS §4 — дефолтная модель),
 *           параметры плоского вызова дня 22: temperature 0, maxTokens 900.
 *
 * Честная пометка (фиксируется в артефакте meta.note): retrieval общий с
 * ЛОКАЛЬНЫМ бюджетом (≤~1000 ток, k≤6) — оба арма получили одинаковый
 * контекст; продуктовый облачный путь (answer.ts) использует 3k/16 — здесь
 * НЕ воспроизведено.
 *
 * Заглушки day25-класса в облачном arm'е: пустой/почти пустой ответ
 * (<20 симв.) → 1 ретрай (флаг runs[].stubRetry, счётчик в агрегате).
 *
 * Метрики на arm: успех (непустой ответ), латентность p50/средняя, ток/с,
 * заземление-прокси (доля retrieved-источников, чьи ключевые слова —
 * нормализованные токены len≥4 из basename+title — найдены в ответе через
 * normalizeRu), стабильность (одинаковый вердикт «заземлён/нет» во всех
 * прогонах; 1 прогон → null).
 *
 * Артефакт: data/rag/compare-local.json (+ таблица в консоль).
 *
 * ⚠ Ledger single-writer (F-05-2, как rag:eval): облачные вызовы пишутся в
 * usage-ledger — при запущенном сервере записи могут потеряться (на смоке
 * допустимо; полный прогон — с остановленным сервером).
 */

/** Локальный arm — 1.5b (производительная локальная; 0.5b — VPS-класс). */
const LOCAL_MODEL = "qwen2.5:1.5b";
/** Параметры облачного arm'а — плоский вызов дня 22 (константы answer.ts). */
const CLOUD_TEMPERATURE = 0;
const CLOUD_MAX_TOKENS = 900;
const CLOUD_TIMEOUT_MS = 60_000;
/** Заглушка day25-класса: короче 20 симв. → ретрай. */
const STUB_MIN_CHARS = 20;

const LIMIT = Number(
  process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 8,
);
const RUNS = Number(
  process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 2,
);
/** --report: печать агрегата из готового артефакта без пересчёта (day 28). */
const REPORT_ONLY = process.argv.includes("--report");

interface EvalQuestion {
  id: string;
  q: string;
}

interface RunRow {
  ok: boolean;
  replyChars: number;
  latencyMs: number;
  completionTokens: number;
  tokensPerSec: number | null;
  /** Доля инъецированных источников, чьи ключевые слова есть в ответе. */
  grounding: number | null;
  stubRetry: boolean;
  error?: string;
}

interface ArmAggregate {
  runs: RunRow[];
  successShare: number;
  latencyP50Ms: number;
  latencyMeanMs: number;
  tokensPerSecMean: number | null;
  groundingMean: number | null;
  stability: boolean | null;
  stubRetries: number;
}

/** Нижняя медиана (p50) — устойчива к чётному числу прогонов. */
function percentileLow(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Ключевые слова источника: нормализованные токены len≥4 из basename-стема
 * (без .md, дефисы/подчёркивания → пробелы) и title чанка. */
function sourceKeywords(s: { source: string; title: string }): string[] {
  const stem = path
    .basename(s.source)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ");
  return [
    ...new Set(normalizeRu(`${stem} ${s.title}`).split(" ").filter((t) => t.length >= 4)),
  ];
}

function groundingProxy(
  answer: string,
  sources: { source: string; title: string }[],
): number | null {
  if (sources.length === 0) return null;
  const norm = normalizeRu(answer);
  const hits = sources.filter((s) => sourceKeywords(s).some((k) => norm.includes(k)));
  return round(hits.length / sources.length, 3);
}

function aggregate(runs: RunRow[]): ArmAggregate {
  const ok = runs.filter((r) => r.ok);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const tps = ok.map((r) => r.tokensPerSec).filter((t): t is number => t !== null);
  const groundings = ok.map((r) => r.grounding).filter((g): g is number => g !== null);
  const verdicts = groundings.map((g) => g > 0);
  return {
    runs,
    successShare: round(ok.length / Math.max(1, runs.length), 3),
    latencyP50Ms: percentileLow(latencies),
    latencyMeanMs: round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length), 0),
    tokensPerSecMean: tps.length ? round(tps.reduce((a, b) => a + b, 0) / tps.length, 1) : null,
    groundingMean: groundings.length
      ? round(groundings.reduce((a, b) => a + b, 0) / groundings.length, 3)
      : null,
    stability: verdicts.length >= 2 ? verdicts.every((v) => v === verdicts[0]) : null,
    stubRetries: runs.filter((r) => r.stubRetry).length,
  };
}

/** Локальный ход бесплатен — нулевой usage-литерал (паттерн D-26-5). */
function localZeroUsage(model: string): LlmUsage {
  return {
    model,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    estimated_cost_usd: 0,
    estimated_cost_rub: 0,
  };
}

function errorRow(err: unknown): RunRow {
  return {
    ok: false,
    replyChars: 0,
    latencyMs: 0,
    completionTokens: 0,
    tokensPerSec: null,
    grounding: null,
    stubRetry: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Форма артефакта, достаточная для --report (пишется полным прогоном ниже). */
interface CompareArtifact {
  generatedAt: string;
  meta: {
    models: { local: string; cloud: string };
    runs: number;
    limit: number;
  };
  questions: unknown[];
  aggregate: { local: ArmAggregate; cloud: ArmAggregate };
}

/** Статистика retrieval-фазы (общей на вопрос) — строка под таблицей. */
interface RetrievalStats {
  questions: number;
  p50Ms: number;
  injectedMin: number;
  injectedMax: number;
}

/** Медиана латентности retrieval + диапазон инжектированных фрагментов.
 *  Принимает и типизированные rows полного прогона, и questions[] артефакта. */
function retrievalStats(rows: readonly unknown[]): RetrievalStats | null {
  const lat: number[] = [];
  const inj: number[] = [];
  let count = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = (row as { retrieval?: { latencyMs?: unknown; injectedCount?: unknown } })
      .retrieval;
    if (typeof r?.latencyMs === "number" && Number.isFinite(r.latencyMs)) {
      lat.push(r.latencyMs);
    }
    if (typeof r?.injectedCount === "number" && Number.isFinite(r.injectedCount)) {
      inj.push(r.injectedCount);
    }
    count += 1;
  }
  if (lat.length === 0) return null;
  lat.sort((a, b) => a - b);
  return {
    questions: count,
    p50Ms: percentileLow(lat),
    injectedMin: inj.length ? Math.min(...inj) : 0,
    injectedMax: inj.length ? Math.max(...inj) : 0,
  };
}

/** Таблица агрегата — одна на полный прогон и --report (одинаковый вывод).
 *  Читаемость (cust-fix 10.10 «в»): русские подписи армов, успех N/M,
 *  заземление в %, стабильность да/нет, строка retrieval и легенда колонок. */
function printComparisonTable(
  local: ArmAggregate,
  cloud: ArmAggregate,
  meta: { localLabel: string; cloudLabel: string; retrieval: RetrievalStats | null },
): void {
  const ru = (n: number): string => n.toFixed(1).replace(".", ",");
  console.log("\nИтог (агрегат по прогонам):");
  console.log(
    "| Модель | Успех | Генерация p50, с | Ток/с | Заземление | Стабильность | Ретраи |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const [label, a] of [
    [meta.localLabel, local],
    [meta.cloudLabel, cloud],
  ] as const) {
    const okCount = a.runs.filter((r) => r.ok).length;
    const grounding =
      a.groundingMean != null
        ? `${ru(a.groundingMean * 100)}%`
        : "—";
    const stability = a.stability == null ? "—" : a.stability ? "да" : "нет";
    console.log(
      `| ${label} | ${okCount}/${a.runs.length} | ${ru(a.latencyP50Ms / 1000)} | ${a.tokensPerSecMean != null ? ru(a.tokensPerSecMean) : "—"} | ${grounding} | ${stability} | ${a.stubRetries} |`,
    );
  }
  if (meta.retrieval) {
    const r = meta.retrieval;
    const injected =
      r.injectedMin === r.injectedMax
        ? String(r.injectedMin)
        : `${r.injectedMin}–${r.injectedMax}`;
    console.log(
      `\nПоиск по базе (общий на вопрос, ${r.questions} вопросов): медиана ${ru(r.p50Ms / 1000)} с · в контекст ${injected} фрагм. (бюджет ≤~1000 ток, k≤6)`,
    );
  }
  console.log("\nКак читать таблицу:");
  console.log("Успех — прогоны с непустым ответом из всех прогонов.");
  console.log(
    "Генерация p50 — медианная латентность генерации; поиск по базе общий и в неё не входит.",
  );
  console.log("Ток/с — скорость генерации (токенов ответа в секунду).");
  console.log(
    "Заземление — доля найденных источников, чьи ключевые слова есть в ответе (опора на базу).",
  );
  console.log(
    "Стабильность — одинаковый ли вердикт «заземлён» во всех прогонах.",
  );
  console.log(
    "Ретраи — повторы из-за пустого ответа облака (короче 20 символов).",
  );
  console.log("\nАртефакт: data/rag/compare-local.json");
}

/** --report: та же таблица агрегата из существующего артефакта, БЕЗ
 *  пересчёта и без требования env/Ollama (сцена 4 скринкаста дня 28).
 *  Нет артефакта или он чужой — ясная ошибка, не фейк. */
async function reportFromArtifact(): Promise<number> {
  const artifactPath = path.join(repoRoot, "data/rag/compare-local.json");
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch {
    console.error(
      "[rag:compare] --report: артефакт data/rag/compare-local.json не найден — сначала полный прогон: npm run rag:compare",
    );
    return 1;
  }
  let artifact: CompareArtifact;
  try {
    artifact = JSON.parse(raw) as CompareArtifact;
  } catch {
    console.error(
      "[rag:compare] --report: артефакт data/rag/compare-local.json не читается (битый JSON)",
    );
    return 1;
  }
  if (!artifact?.aggregate?.local || !artifact.aggregate.cloud) {
    console.error(
      "[rag:compare] --report: в артефакте нет aggregate.local/cloud — файл повреждён или оставлен другой версией скрипта",
    );
    return 1;
  }
  console.log(
    `[rag:compare] отчёт по артефакту от ${artifact.generatedAt} · локальная=${artifact.meta?.models?.local ?? "?"} · облачная=${artifact.meta?.models?.cloud ?? "?"} · прогонов на вопрос: ${artifact.meta?.runs ?? "?"}`,
  );
  printComparisonTable(artifact.aggregate.local, artifact.aggregate.cloud, {
    localLabel: `локальная ${artifact.meta?.models?.local ?? "?"}`,
    cloudLabel: `облачная ${artifact.meta?.models?.cloud ?? "?"}`,
    retrieval: retrievalStats(artifact.questions),
  });
  return 0;
}

async function main(): Promise<number> {
  if (!Number.isInteger(LIMIT) || LIMIT < 1 || !Number.isInteger(RUNS) || RUNS < 1) {
    console.error("[rag:compare] --limit/--runs — целые ≥1");
    return 2;
  }
  if (REPORT_ONLY) return reportFromArtifact();
  const env = loadEnv();
  const rag = createRagService(env);
  const reranker = createReranker(env);
  const deepSeek = createDeepSeekService(env);
  const ledger = createUsageLedgerService(env.USAGE_FILE);

  // Контрольные вопросы — первые `limit` из eval-списка дней 22–24.
  const raw = JSON.parse(
    await fs.readFile(path.join(repoRoot, "data/rag/eval-questions.json"), "utf8"),
  ) as { questions?: EvalQuestion[] };
  const questions = (raw.questions ?? []).slice(0, LIMIT);
  if (questions.length === 0) {
    console.error("[rag:compare] eval-questions.json пуст/отсутствует");
    return 1;
  }

  // Локальный arm: рантайм и модель должны стоять (паттерн local-llm-check).
  const probe = await probeLocalLlm(env);
  if (!probe.enabled || !probe.runtimeOk) {
    console.error("[rag:compare] SKIP: рантайм Ollama недоступен/отключён");
    return 1;
  }
  if (
    !isLocalCatalogId(LOCAL_MODEL) ||
    probe.entries.find((e) => e.id === LOCAL_MODEL)?.installed !== true
  ) {
    console.error(`[rag:compare] SKIP: модель ${LOCAL_MODEL} не установлена — ollama pull ${LOCAL_MODEL}`);
    return 1;
  }
  console.log(
    `[rag:compare] ${questions.length} вопросов × ${RUNS} прогона × 2 арма · local=${LOCAL_MODEL} · cloud=${env.DEEPSEEK_MODEL}`,
  );
  console.log(
    "[rag:compare] ledger — единый писатель: при запущенном сервере записи могут потеряться (F-05-2)",
  );

  /** Облачный вызов (plain text, без jsonMode) + ledger; заглушка → 1 ретрай. */
  const cloudCall = async (
    system: string,
    q: string,
    sources: { source: string; title: string }[],
  ): Promise<RunRow> => {
    const call = async () => {
      const started = Date.now();
      const r = await deepSeek.chat(
        [
          { role: "system", content: system },
          { role: "user", content: q },
        ],
        {
          model: env.DEEPSEEK_MODEL,
          temperature: CLOUD_TEMPERATURE,
          maxTokens: CLOUD_MAX_TOKENS,
          timeoutMs: CLOUD_TIMEOUT_MS,
        },
      );
      return { r, latencyMs: Date.now() - started };
    };
    let { r, latencyMs } = await call();
    let stubRetry = false;
    if (r.reply.trim().length < STUB_MIN_CHARS) {
      stubRetry = true;
      const retry = await call();
      if (retry.r.reply.trim().length > 0) {
        r = retry.r;
        latencyMs = retry.latencyMs;
      }
    }
    await ledger.record(r.usage, { countExpensive: false });
    return {
      ok: r.reply.trim().length > 0,
      replyChars: r.reply.length,
      latencyMs,
      completionTokens: r.usage.completion_tokens,
      tokensPerSec:
        r.usage.completion_tokens > 0
          ? round(r.usage.completion_tokens / (latencyMs / 1000), 1)
          : null,
      grounding: groundingProxy(r.reply, sources),
      stubRetry,
    };
  };

  const rows: {
    id: string;
    q: string;
    retrieval: unknown;
    local: ArmAggregate;
    cloud: ArmAggregate;
  }[] = [];
  for (const question of questions) {
    process.stdout.write(`[rag:compare] ${question.id} retrieval … `);
    // Retrieval ОДИН РАЗ на вопрос, без dontKnow-гейта (скоуп §3.1-4).
    const retrieval = await localRagRetrieve(rag, reranker, question.q, {
      dontKnowGate: false,
    });
    console.log(
      `пул ${retrieval.poolRanked} → ${retrieval.injectedCount} в контексте · ${round(retrieval.latencyMs / 1000, 1)} с`,
    );
    // Одинаковый промпт обоим arm'ам — как строит system chatLocalLlm.
    const system = `${LOCAL_LLM_SYSTEM_PROMPT}\n\n${retrieval.contextBlock}`;

    const localRuns: RunRow[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      try {
        const r = await chatLocalLlm(env, {
          model: LOCAL_MODEL,
          q: question.q,
          context: retrieval.contextBlock,
        });
        await ledger.record(localZeroUsage(LOCAL_MODEL), { countExpensive: false });
        localRuns.push({
          ok: r.reply.trim().length > 0,
          replyChars: r.reply.length,
          latencyMs: r.totalMs,
          completionTokens: r.completionTokens,
          tokensPerSec:
            r.completionTokens > 0
              ? round(r.completionTokens / (r.totalMs / 1000), 1)
              : null,
          grounding: groundingProxy(r.reply, retrieval.sources),
          stubRetry: false,
        });
      } catch (err) {
        localRuns.push(errorRow(err));
      }
    }

    const cloudRuns: RunRow[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      try {
        cloudRuns.push(await cloudCall(system, question.q, retrieval.sources));
      } catch (err) {
        cloudRuns.push(errorRow(err));
      }
    }

    rows.push({
      id: question.id,
      q: question.q,
      retrieval: {
        topCosine: retrieval.topCosine,
        poolRanked: retrieval.poolRanked,
        keptAfterFilter: retrieval.keptAfterFilter,
        injectedCount: retrieval.injectedCount,
        rerankLatencyMs: retrieval.rerankLatencyMs,
        latencyMs: retrieval.latencyMs,
      },
      local: aggregate(localRuns),
      cloud: aggregate(cloudRuns),
    });
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    meta: {
      models: { local: LOCAL_MODEL, cloud: env.DEEPSEEK_MODEL },
      runs: RUNS,
      limit: LIMIT,
      budgets: {
        retrieval: "общий на вопрос · локальный бюджет ≤~1000 ток, k≤6 (num_ctx 2048)",
        cloudProduct: "продуктовый облачный путь — 3k/16 (answer.ts), здесь НЕ воспроизведено",
      },
      params: {
        local: "chatLocalLlm, num_ctx 2048, температура рантайма по умолчанию (настройка — день 29)",
        cloud: `deepseek.chat: temperature ${CLOUD_TEMPERATURE}, maxTokens ${CLOUD_MAX_TOKENS}, plain text (без jsonMode)`,
      },
      stubPolicy: `day25-класс: ответ облака < ${STUB_MIN_CHARS} симв. → 1 ретрай (runs[].stubRetry)`,
      note: "Честно: retrieval один на вопрос с ЛОКАЛЬНЫМ бюджетом (≤~1000 ток, k≈6) — оба арма получили одинаковый контекст и одинаковый промпт; армы отличаются только генератором. Продуктовый облачный RAG-путь использует бюджет 3k/16 — сравнение его не воспроизводит. Заземление-прокси — по ключевым словам источников (basename+title через normalizeRu), не по меткам [source › section].",
    },
    questions: rows,
    aggregate: {
      local: aggregate(rows.flatMap((r) => r.local.runs)),
      cloud: aggregate(rows.flatMap((r) => r.cloud.runs)),
    },
  };
  await writeJsonAtomic(path.join(repoRoot, "data/rag/compare-local.json"), artifact);

  printComparisonTable(artifact.aggregate.local, artifact.aggregate.cloud, {
    localLabel: `локальная ${LOCAL_MODEL}`,
    cloudLabel: `облачная ${env.DEEPSEEK_MODEL}`,
    retrieval: retrievalStats(rows),
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[rag:compare] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
