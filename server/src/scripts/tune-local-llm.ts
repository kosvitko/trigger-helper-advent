import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import {
  chatLocalLlm,
  LOCAL_LLM_NUM_PREDICT,
  LOCAL_LLM_SYSTEM_PROMPT,
  LOCAL_LLM_TEMPERATURE,
  localLlmConfig,
  localLlmTuning,
  localLlmWireOptions,
  localRagAssemble,
  localRagRetrieve,
  type LocalLlmOptionsOverride,
} from "../services/local-llm.js";
import { repoRoot } from "../services/rag/paths.js";
import { createReranker } from "../services/rag/rerank.js";
import { createRagService, writeJsonAtomic } from "../services/rag/store.js";
import { normalizeRu } from "../services/rag/text.js";

/**
 * День 29 — A/B «до/после» тюнинга локальной LLM (proposals 261010 §3.1-4).
 *
 *   npm run local-llm:tune                          (8 вопросов × 2 прогона × 3 арма)
 *   npm run local-llm:tune -- --limit=2 --runs=1    (смок)
 *   npm run local-llm:tune -- --report              (таблица из ГОТОВОГО артефакта
 *           data/rag/tune-local.json без пересчёта и без env/Ollama — сцена
 *           терминала в скринкасте; нет артефакта — ясная ошибка, exit 1)
 *
 * Армы (что менялось — proposals §3.1-1/2/3):
 *   до (baseline) — wire-формат дня 28: options ТОЛЬКО {num_ctx: 2048}
 *           (температура/num_predict — дефолты рантайма), базовый промпт
 *           «Отвечай кратко…», контекст бюджет 1000 ток / k 6;
 *   после (tuned) — профиль дня 29 по умолчанию: темп 0.2 / num_predict 320 /
 *           num_ctx 4096 (1.5b) / RAG-промпт / контекст бюджет 2000 ток;
 *   после + квант (tuned-q5) — тот же профиль на q5_k_m. Квант q8_0 (веса
 *           ≈1,65 ГБ, рантайм ≈2,3 ГБ) снят по RAM машины (решение владельца
 *           10.10 «под весь RAM — своп»); q5_k_m — квант-ап в безопасном
 *           классе (+~200 МБ к работающему q4_k_m).
 *
 * Дисциплина памяти: модели грузятся ПО ОДНОЙ — перед квант-arm'ом базовая
 * модель выгружается (POST /api/generate keep_alive: 0), RSS каждой — из
 * GET /api/ps (size) сразу после её холодной загрузки.
 *
 * Retrieval: rank + реранк ОДИН РАЗ на вопрос (localRagRetrieve с бюджетом
 * tuned-профиля, dontKnow-гейт выключен — как rag:compare дня 28) →
 * baseline-контекст пересобирается localRagAssemble из rerankedHits с
 * бюджетом 1000 — без повторного реранка.
 *
 * Метрики на arm: успех, заземление-прокси и стабильность (скоринг дня 28),
 * генерация p50 (нижняя медиана — методика rag:compare), ток/с, средняя
 * длина ответа, средний prompt-токены (кэш-прогоны с prompt_eval_count 0 —
 * исключаются), RAM модели, холодная загрузка (первый ход arm'а).
 *
 * Артефакт: data/rag/tune-local.json (+ таблица в консоль). Ledger НЕ пишем:
 * все ходы локальные ₽0, облачных вызовов нет — нет single-writer-риска.
 */

/** Армы живут на 1.5b (производительная локальная; 0.5b — VPS-класс, day26). */
const BASE_MODEL = "qwen2.5:1.5b";
/** Квант q5_k_m: GGUF с HF + ollama create (рецепт дня 26; реестр ollama
 * с машины недоступен). Не в каталоге продукта — добавит ли запись, решает
 * A/B (§3.1-3: победа по заземлению при приемлемой скорости). */
const Q5_MODEL = "qwen2.5:1.5b-q5";
/** Baseline = день 28: только num_ctx 2048; темп/длина — дефолты рантайма. */
const BASELINE_OPTIONS = { numCtx: 2048 } as const;
const BASELINE_PROMPT_TOKEN_BUDGET = 1000;
/** Профиль дня 29 для квант-arm'а: модель q5 вне каталога — фиксируем
 * профиль 1.5b-класса ЯВНО (fallback localLlmTuning для неизвестного id —
 * 2048/1000, а проверяем 4096/2000). */
const TUNED_PROFILE_OPTIONS: LocalLlmOptionsOverride = {
  temperature: LOCAL_LLM_TEMPERATURE,
  numCtx: localLlmTuning(BASE_MODEL).numCtx,
  numPredict: LOCAL_LLM_NUM_PREDICT,
};

const LIMIT = Number(
  process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 8,
);
const RUNS = Number(
  process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 2,
);
/** --report: печать таблицы из готового артефакта без пересчёта. */
const REPORT_ONLY = process.argv.includes("--report");

interface EvalQuestion {
  id: string;
  q: string;
}

interface RunRow {
  ok: boolean;
  replyChars: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number | null;
  /** Доля источников КОНТЕКСТА ЭТОГО arm'а, чьи ключевые слова есть в ответе. */
  grounding: number | null;
  error?: string;
}

interface ArmAggregate {
  model: string;
  runs: RunRow[];
  successShare: number;
  groundingMean: number | null;
  stability: boolean | null;
  replyCharsMean: number | null;
  latencyP50Ms: number;
  tokensPerSecMean: number | null;
  /** Средний prompt-токены (кэш-прогоны с 0 исключены). */
  promptTokensMean: number | null;
  /** RSS модели в памяти Ollama (GET /api/ps, МБ); null = не прочитан. */
  ramMb: number | null;
  /** Первый ход arm'а — загрузка весов (мс); null = arm стартовал по горячей. */
  coldLoadMs: number | null;
}

type ArmKey = "baseline" | "tuned" | "tunedQ5";

interface ArmConfig {
  key: ArmKey;
  label: string;
  model: string;
  useTunedProfile: boolean;
  /** Явные options (квант-модель вне каталога — профиль 1.5b-класса). */
  options?: LocalLlmOptionsOverride;
}

const ARMS: readonly ArmConfig[] = [
  {
    key: "baseline",
    label:
      "до · день 28 (q4_k_m, num_ctx 2048, темп рантайма 0.8, промпт «кратко», контекст ≤1000 ток)",
    model: BASE_MODEL,
    useTunedProfile: false,
  },
  {
    key: "tuned",
    label:
      "после · тюнинг (q4_k_m, num_ctx 4096, темп 0.2, num_predict 320, RAG-промпт, контекст ≤2000 ток)",
    model: BASE_MODEL,
    useTunedProfile: true,
  },
  {
    key: "tunedQ5",
    label: "после + квант q5_k_m (тот же профиль дня 29)",
    model: Q5_MODEL,
    useTunedProfile: true,
    options: TUNED_PROFILE_OPTIONS,
  },
];

/** Нижняя медиана (p50) — методика rag:compare дня 28. */
function percentileLow(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Ключевые слова источника — дословно скоринг дня 28 (compare-local-rag.ts):
 * нормализованные токены len≥4 из basename-стема и title чанка. */
function sourceKeywords(s: { source: string; title: string }): string[] {
  const stem = path
    .basename(s.source)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ");
  return [
    ...new Set(
      normalizeRu(`${stem} ${s.title}`)
        .split(" ")
        .filter((t) => t.length >= 4),
    ),
  ];
}

function groundingProxy(
  answer: string,
  sources: { source: string; title: string }[],
): number | null {
  if (sources.length === 0) return null;
  const norm = normalizeRu(answer);
  const hits = sources.filter((s) =>
    sourceKeywords(s).some((k) => norm.includes(k)),
  );
  return round(hits.length / sources.length, 3);
}

function aggregate(
  model: string,
  runs: RunRow[],
  ramMb: number | null,
  coldLoadMs: number | null,
): ArmAggregate {
  const ok = runs.filter((r) => r.ok);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const tps = ok
    .map((r) => r.tokensPerSec)
    .filter((t): t is number => t !== null);
  const groundings = ok
    .map((r) => r.grounding)
    .filter((g): g is number => g !== null);
  const verdicts = groundings.map((g) => g > 0);
  const promptTokens = ok.map((r) => r.promptTokens).filter((p) => p > 0);
  const chars = ok.map((r) => r.replyChars);
  return {
    model,
    runs,
    successShare: round(ok.length / Math.max(1, runs.length), 3),
    groundingMean: groundings.length
      ? round(groundings.reduce((a, b) => a + b, 0) / groundings.length, 3)
      : null,
    stability:
      verdicts.length >= 2 ? verdicts.every((v) => v === verdicts[0]) : null,
    replyCharsMean: chars.length
      ? round(chars.reduce((a, b) => a + b, 0) / chars.length, 0)
      : null,
    latencyP50Ms: percentileLow(latencies),
    tokensPerSecMean: tps.length
      ? round(tps.reduce((a, b) => a + b, 0) / tps.length, 1)
      : null,
    promptTokensMean: promptTokens.length
      ? round(promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length, 0)
      : null,
    ramMb,
    coldLoadMs,
  };
}

function errorRow(err: unknown): RunRow {
  return {
    ok: false,
    replyChars: 0,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokensPerSec: null,
    grounding: null,
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Контексты и источники одного вопроса: retrieval один раз (tuned-бюджет),
 * baseline-контекст — пересборка из rerankedHits с бюджетом дня 28. */
interface QuestionData {
  id: string;
  q: string;
  tunedContext: string;
  tunedSources: { source: string; title: string }[];
  baselineContext: string;
  baselineSources: { source: string; title: string }[];
  retrieval: {
    topCosine: number;
    poolRanked: number;
    injectedTuned: number;
    injectedBaseline: number;
    rerankLatencyMs: number;
    latencyMs: number;
  };
}

interface RetrievalSummary {
  questions: number;
  p50Ms: number;
  injectedTunedMin: number;
  injectedTunedMax: number;
  injectedBaselineMin: number;
  injectedBaselineMax: number;
}

/** RSS модели в памяти Ollama (GET /api/ps size → МБ); null = не прочитан. */
async function ollamaModelRamMb(
  baseUrl: string,
  model: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      models?: Array<{ name?: unknown; size?: unknown }>;
    };
    const entry = json.models?.find(
      (m) =>
        typeof m.name === "string" &&
        (m.name === model || m.name.replace(/:latest$/, "") === model),
    );
    return typeof entry?.size === "number"
      ? Math.round((entry.size as number) / (1024 * 1024))
      : null;
  } catch {
    return null;
  }
}

/** Выгрузка модели (документированный паттерн Ollama): keep_alive 0 —
 * после запроса веса покидают память (дисциплина «одна модель за раз»). */
async function ollamaUnload(baseUrl: string, model: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort: не валим прогон из-за неудачной выгрузки
  }
}

/** Установленные модели (GET /api/tags) — без каталога продукта: q5-модель
 * живёт только в Ollama (arm скрипта), каталог не расширяется до победы. */
async function installedModels(baseUrl: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const names = new Set<string>();
    for (const m of json.models ?? []) {
      if (typeof m.name === "string" && m.name.length > 0) names.add(m.name);
    }
    return names;
  } catch {
    return null;
  }
}

const ru = (n: number): string => n.toFixed(1).replace(".", ",");
const ruInt = (n: number): string => Math.round(n).toLocaleString("ru-RU");

/** Таблица агрегата — одинаковый вывод у полного прогона и --report. */
function printTuneTable(
  agg: Record<ArmKey, ArmAggregate>,
  retrieval: RetrievalSummary | null,
): void {
  console.log("\nИтог (агрегат по прогонам):");
  console.log(
    "| Конфигурация | Успех | Заземление | Стабильность | Ответ, симв | Генерация p50, с | Ток/с | Prompt, ток | RAM, МБ | Холодный старт, с |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of ARMS) {
    const a = agg[arm.key];
    const okCount = a.runs.filter((r) => r.ok).length;
    const grounding =
      a.groundingMean != null ? `${ru(a.groundingMean * 100)}%` : "—";
    const stability = a.stability == null ? "—" : a.stability ? "да" : "нет";
    const chars = a.replyCharsMean != null ? ruInt(a.replyCharsMean) : "—";
    const tps = a.tokensPerSecMean != null ? ru(a.tokensPerSecMean) : "—";
    const prompt = a.promptTokensMean != null ? ruInt(a.promptTokensMean) : "—";
    const ram = a.ramMb != null ? ruInt(a.ramMb) : "—";
    const cold = a.coldLoadMs != null ? ru(a.coldLoadMs / 1000) : "—";
    console.log(
      `| ${arm.label} | ${okCount}/${a.runs.length} | ${grounding} | ${stability} | ${chars} | ${ru(a.latencyP50Ms / 1000)} | ${tps} | ${prompt} | ${ram} | ${cold} |`,
    );
  }
  if (retrieval) {
    const r = retrieval;
    const range = (min: number, max: number): string =>
      min === max ? String(min) : `${min}–${max}`;
    console.log(
      `\nПоиск по базе (общий на вопрос, ${r.questions} вопросов): медиана ${ru(r.p50Ms / 1000)} с · в контекст ${range(r.injectedBaselineMin, r.injectedBaselineMax)} фрагм. (бюджет 1000) → ${range(r.injectedTunedMin, r.injectedTunedMax)} фрагм. (бюджет 2000)`,
    );
  }
  console.log("\nКак читать таблицу:");
  console.log(
    "Успех — прогоны с непустым ответом из всех прогонов (вопросы × прогоны).",
  );
  console.log(
    "Заземление — доля источников контекста, чьи ключевые слова есть в ответе (опора на базу; скоринг дня 28).",
  );
  console.log(
    "Стабильность — одинаковый ли вердикт «заземлён» во всех прогонах.",
  );
  console.log(
    "Ответ, симв — средняя длина ответа: промпт дня 29 просит 2–4 предложения вместо «кратко».",
  );
  console.log(
    "Генерация p50 — медиана латентности генерации; поиск по базе общий и в неё не входит; повторный прогон того же вопроса попадает в prompt-кэш рантайма (методика дня 28 сохранена).",
  );
  console.log("Ток/с — скорость генерации ответа.");
  console.log(
    "Prompt, ток — средний размер промпта (у tuned контекст вдвое больше: бюджет 2000 против 1000).",
  );
  console.log("RAM, МБ — размер модели в памяти Ollama (GET /api/ps).");
  console.log(
    "Холодный старт — первый ход arm'а (загрузка весов); tuned стартует по уже горячей модели (cold — у baseline), квант — свой cold после выгрузки базовой.",
  );
  console.log(
    "Квантование: q8_0 (веса ≈1,65 ГБ) отклонён по RAM машины (решение владельца 10.10); опробован q5_k_m.",
  );
  console.log("\nАртефакт: data/rag/tune-local.json");
}

interface TuneArtifact {
  generatedAt: string;
  meta: {
    models: Record<ArmKey, string>;
    runs: number;
    limit: number;
    params: Record<ArmKey, string>;
    note: string;
  };
  questions: unknown[];
  aggregate: Record<ArmKey, ArmAggregate>;
}

/** --report: таблица из существующего артефакта, БЕЗ пересчёта и без
 * требований env/Ollama. Нет артефакта/чужая форма — ясная ошибка, не фейк. */
async function reportFromArtifact(): Promise<number> {
  const artifactPath = path.join(repoRoot, "data/rag/tune-local.json");
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch {
    console.error(
      "[local-llm:tune] --report: артефакт data/rag/tune-local.json не найден — сначала полный прогон: npm run local-llm:tune",
    );
    return 1;
  }
  let artifact: TuneArtifact;
  try {
    artifact = JSON.parse(raw) as TuneArtifact;
  } catch {
    console.error(
      "[local-llm:tune] --report: артефакт data/rag/tune-local.json не читается (битый JSON)",
    );
    return 1;
  }
  if (!artifact?.aggregate?.baseline || !artifact.aggregate.tuned) {
    console.error(
      "[local-llm:tune] --report: в артефакте нет aggregate.baseline/tuned — файл повреждён или оставлен другой версией скрипта",
    );
    return 1;
  }
  const questions = Array.isArray(artifact.questions) ? artifact.questions : [];
  const lat: number[] = [];
  const injT: number[] = [];
  const injB: number[] = [];
  for (const row of questions) {
    if (typeof row !== "object" || row === null) continue;
    const r = (row as { retrieval?: Record<string, unknown> }).retrieval;
    if (typeof r?.latencyMs === "number") lat.push(r.latencyMs);
    if (typeof r?.injectedTuned === "number") injT.push(r.injectedTuned);
    if (typeof r?.injectedBaseline === "number") injB.push(r.injectedBaseline);
  }
  const hasAggregate = (key: ArmKey): key is ArmKey => key in artifact.aggregate;
  if (!hasAggregate("baseline") || !hasAggregate("tuned")) {
    console.error("[local-llm:tune] --report: aggregate неполный");
    return 1;
  }
  console.log(
    `[local-llm:tune] отчёт по артефакту от ${artifact.generatedAt} · прогонов на вопрос: ${artifact.meta?.runs ?? "?"} · вопросов: ${artifact.meta?.limit ?? "?"}`,
  );
  printTuneTable(artifact.aggregate, {
    questions: questions.length,
    p50Ms: percentileLow([...lat].sort((a, b) => a - b)),
    injectedTunedMin: injT.length ? Math.min(...injT) : 0,
    injectedTunedMax: injT.length ? Math.max(...injT) : 0,
    injectedBaselineMin: injB.length ? Math.min(...injB) : 0,
    injectedBaselineMax: injB.length ? Math.max(...injB) : 0,
  });
  return 0;
}

async function main(): Promise<number> {
  if (
    !Number.isInteger(LIMIT) ||
    LIMIT < 1 ||
    !Number.isInteger(RUNS) ||
    RUNS < 1
  ) {
    console.error("[local-llm:tune] --limit/--runs — целые ≥1");
    return 2;
  }
  if (REPORT_ONLY) return reportFromArtifact();

  const env = loadEnv();
  const { baseUrl } = localLlmConfig(env);
  const rag = createRagService(env);
  const reranker = createReranker(env);

  const raw = JSON.parse(
    await fs.readFile(path.join(repoRoot, "data/rag/eval-questions.json"), "utf8"),
  ) as { questions?: EvalQuestion[] };
  const questions = (raw.questions ?? []).slice(0, LIMIT);
  if (questions.length === 0) {
    console.error("[local-llm:tune] eval-questions.json пуст/отсутствует");
    return 1;
  }

  const installed = await installedModels(baseUrl);
  if (installed === null) {
    console.error(`[local-llm:tune] SKIP: рантайм Ollama недоступен (${baseUrl})`);
    return 1;
  }
  for (const m of [BASE_MODEL, Q5_MODEL]) {
    if (!installed.has(m)) {
      console.error(
        `[local-llm:tune] SKIP: модель ${m} не установлена` +
          (m === Q5_MODEL
            ? ` — GGUF q5_k_m с HF + ollama create ${Q5_MODEL} (рецепт дня 26, NOTES)`
            : ` — ollama pull ${m}`),
      );
      return 1;
    }
  }

  const tunedBudget = localLlmTuning(BASE_MODEL).ragPromptTokenBudget;
  console.log(
    `[local-llm:tune] ${questions.length} вопросов × ${RUNS} прогона × ${ARMS.length} арма · дисциплина памяти: одна модель в памяти, выгрузка между arm'ами`,
  );

  // — Фаза A: retrieval один раз на вопрос (tuned-бюджет); baseline-контекст
  //   пересобирается из rerankedHits с бюджетом дня 28 (без повторного реранка).
  const datas: QuestionData[] = [];
  for (const question of questions) {
    process.stdout.write(`[local-llm:tune] ${question.id} retrieval … `);
    const retrieval = await localRagRetrieve(rag, reranker, question.q, {
      dontKnowGate: false,
      promptTokenBudget: tunedBudget,
    });
    const baselineAsm = localRagAssemble(retrieval.rerankedHits, {
      promptTokenBudget: BASELINE_PROMPT_TOKEN_BUDGET,
    });
    console.log(
      `пул ${retrieval.poolRanked} → в контексте ${baselineAsm.injectedCount} (бюджет 1000) / ${retrieval.injectedCount} (бюджет ${tunedBudget}) · ${round(retrieval.latencyMs / 1000, 1)} с`,
    );
    datas.push({
      id: question.id,
      q: question.q,
      tunedContext: retrieval.contextBlock,
      tunedSources: retrieval.sources,
      baselineContext: baselineAsm.contextBlock,
      baselineSources: baselineAsm.sources,
      retrieval: {
        topCosine: retrieval.topCosine,
        poolRanked: retrieval.poolRanked,
        injectedTuned: retrieval.injectedCount,
        injectedBaseline: baselineAsm.injectedCount,
        rerankLatencyMs: retrieval.rerankLatencyMs,
        latencyMs: retrieval.latencyMs,
      },
    });
  }

  const rows: Record<ArmKey, RunRow[]> = {
    baseline: [],
    tuned: [],
    tunedQ5: [],
  };
  const ramMb: Record<ArmKey, number | null> = {
    baseline: null,
    tuned: null,
    tunedQ5: null,
  };
  const coldMs: Record<ArmKey, number | null> = {
    baseline: null,
    tuned: null,
    tunedQ5: null,
  };

  /** Прогоны arm'а по готовым контекстам (холодный старт — отдельно). */
  const genLoop = async (arm: ArmConfig): Promise<void> => {
    for (const data of datas) {
      for (let i = 0; i < RUNS; i += 1) {
        process.stdout.write(`  ${data.id} ${arm.key} прогон ${i + 1}/${RUNS} … `);
        try {
          const r = await chatLocalLlm(env, {
            model: arm.model,
            q: data.q,
            ...(arm.useTunedProfile
              ? {
                  context: data.tunedContext,
                  ...(arm.options ? { options: arm.options } : {}),
                }
              : {
                  context: data.baselineContext,
                  systemPrompt: LOCAL_LLM_SYSTEM_PROMPT,
                  options: BASELINE_OPTIONS,
                }),
          });
          const sources = arm.useTunedProfile
            ? data.tunedSources
            : data.baselineSources;
          rows[arm.key].push({
            ok: r.reply.trim().length > 0,
            replyChars: r.reply.length,
            latencyMs: r.totalMs,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            tokensPerSec:
              r.completionTokens > 0
                ? round(r.completionTokens / (r.totalMs / 1000), 1)
                : null,
            grounding: groundingProxy(r.reply, sources),
          });
          console.log(
            `${r.reply.trim().length > 0 ? "ok" : "ПУСТО"} · ${ru(r.totalMs / 1000)} с · prompt ${r.promptTokens} · ${r.completionTokens} ток`,
          );
        } catch (err) {
          rows[arm.key].push(errorRow(err));
          console.log(`ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };

  // — Фаза B: базовая модель q4_k_m — холодный старт (засчитан baseline'у:
  // первый ход), затем baseline → tuned по горячей модели.
  console.log("\n[Фаза B] базовая модель q4_k_m (cold → baseline → tuned)");
  {
    const t0 = Date.now();
    await chatLocalLlm(env, {
      model: BASE_MODEL,
      q: datas[0]!.q,
      context: datas[0]!.tunedContext,
    });
    coldMs.baseline = Date.now() - t0;
    ramMb.baseline = await ollamaModelRamMb(baseUrl, BASE_MODEL);
    ramMb.tuned = ramMb.baseline; // та же модель в памяти
    console.log(
      `→ cold ${ru(coldMs.baseline / 1000)} с · RAM ${ramMb.baseline ?? "?"} МБ`,
    );
  }
  for (const arm of ARMS.filter((a) => a.model === BASE_MODEL)) {
    await genLoop(arm);
  }

  // — Фаза C: квант q5_k_m — выгрузить базовую (дисциплина памяти: одна
  // модель за раз), cold-старт кванта, прогоны тем же tuned-профилем.
  const q5Arm = ARMS.find((a) => a.model === Q5_MODEL);
  if (q5Arm) {
    console.log(`\n[Фаза C] выгрузка ${BASE_MODEL} (keep_alive: 0) → квант ${Q5_MODEL}`);
    await ollamaUnload(baseUrl, BASE_MODEL);
    const t0 = Date.now();
    await chatLocalLlm(env, {
      model: Q5_MODEL,
      q: datas[0]!.q,
      context: datas[0]!.tunedContext,
      options: TUNED_PROFILE_OPTIONS,
    });
    coldMs.tunedQ5 = Date.now() - t0;
    ramMb.tunedQ5 = await ollamaModelRamMb(baseUrl, Q5_MODEL);
    console.log(
      `→ cold ${ru(coldMs.tunedQ5 / 1000)} с · RAM ${ramMb.tunedQ5 ?? "?"} МБ`,
    );
    await genLoop(q5Arm);
  }

  const aggregateAll: Record<ArmKey, ArmAggregate> = {
    baseline: aggregate(BASE_MODEL, rows.baseline, ramMb.baseline, coldMs.baseline),
    tuned: aggregate(BASE_MODEL, rows.tuned, ramMb.tuned, coldMs.tuned),
    tunedQ5: aggregate(Q5_MODEL, rows.tunedQ5, ramMb.tunedQ5, coldMs.tunedQ5),
  };

  const artifact: TuneArtifact = {
    generatedAt: new Date().toISOString(),
    meta: {
      models: { baseline: BASE_MODEL, tuned: BASE_MODEL, tunedQ5: Q5_MODEL },
      runs: RUNS,
      limit: LIMIT,
      params: {
        baseline: `день 28: options ${JSON.stringify(localLlmWireOptions(BASE_MODEL, BASELINE_OPTIONS))}, базовый промпт, контекст бюджет ${BASELINE_PROMPT_TOKEN_BUDGET} ток / k 6`,
        tuned: `день 29: options ${JSON.stringify(localLlmWireOptions(BASE_MODEL))}, RAG-промпт, контекст бюджет ${tunedBudget} ток / k 6`,
        tunedQ5: `день 29: options ${JSON.stringify(localLlmWireOptions(BASE_MODEL, TUNED_PROFILE_OPTIONS))} (профиль 1.5b; модель вне каталога), RAG-промпт, контекст бюджет ${tunedBudget} ток / k 6 — квант q5_k_m`,
      },
      note: "Retrieval общий на вопрос (rank + реранк один раз, dontKnow-гейт выключен); baseline-контекст — пересборка localRagAssemble с бюджетом 1000. Заземление — по ключевым словам источников контекста arm'а (скоринг дня 28). q8_0 (веса ≈1,65 ГБ) отклонён по RAM машины — решение владельца 10.10; вместо него опробован q5_k_m. Дисциплина памяти: одна модель в памяти (выгрузка между фазами), RAM — GET /api/ps.",
    },
    questions: datas.map((d, i) => ({
      id: d.id,
      q: d.q,
      retrieval: d.retrieval,
      runs: {
        baseline: rows.baseline.slice(i * RUNS, (i + 1) * RUNS),
        tuned: rows.tuned.slice(i * RUNS, (i + 1) * RUNS),
        tunedQ5: rows.tunedQ5.slice(i * RUNS, (i + 1) * RUNS),
      },
    })),
    aggregate: aggregateAll,
  };
  await writeJsonAtomic(
    path.join(repoRoot, "data/rag/tune-local.json"),
    artifact,
  );

  const lat = datas.map((d) => d.retrieval.latencyMs).sort((a, b) => a - b);
  printTuneTable(aggregateAll, {
    questions: datas.length,
    p50Ms: percentileLow(lat),
    injectedTunedMin: Math.min(...datas.map((d) => d.retrieval.injectedTuned)),
    injectedTunedMax: Math.max(...datas.map((d) => d.retrieval.injectedTuned)),
    injectedBaselineMin: Math.min(...datas.map((d) => d.retrieval.injectedBaseline)),
    injectedBaselineMax: Math.max(...datas.map((d) => d.retrieval.injectedBaseline)),
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      `[local-llm:tune] FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
