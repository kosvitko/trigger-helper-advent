import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildContextDataBlock, type ChatContextTail } from "@trigger-helper/shared";
import type { Env } from "../config/env.js";
import { estimateTokens } from "./agent/token-estimate.js";
import type { RagAskSource } from "./rag/answer.js";
import { repoRoot } from "./rag/paths.js";
import type { Reranker } from "./rag/rerank.js";
import { RagUnavailableError, type RagService, type SearchHit } from "./rag/store.js";

/**
 * День 26 — локальная LLM в продукте (design §2.1, D-26-1/3/4).
 * День 27 — история диалога (proposals 261009 §3.1): ходка принимает history
 * (клиентский contextTail через localHistoryTurns с локальными капами) —
 * messages = system + history + user; trace.historyMessages — evidence.
 * День 28 — RAG в локальной ветке (proposals 261009 §3.1-1/2): детерминиро-
 * ванный retrieval (localRagRetrieve) + retrieved-контекст параметром
 * context (SEC-F3-блок в system-промпт).
 * День 29 — тюнинг-профиль (proposals 261010 §3.1): параметры генерации
 * (темп 0.2 / num_predict 320 / num_ctx и бюджет контекста per-entry из
 * каталога) + RAG-промпт под кейс; localRagAssemble выделен для A/B
 * скрипта local-llm:tune (бюджеты baseline/tuned из одного ranking).
 *
 * Рантайм — Ollama на 127.0.0.1:11434 (D-26-1, одинаковый локально и на
 * VPS); продукт ходит в него нативным fetch — зависимости сервера +0.
 *
 * Каталог — константа (D-26-4). Запись «доступна» = рантайм поднят
 * (GET /api/tags, кэш 30 с) && модель установлена && os.totalmem() ≥
 * minTotalRamMb. totalmem — deliberate: сравниваем ВСЮ RAM, swap не ломает
 * порог (free-after-swap был бы лживым в обе стороны).
 *
 * Негативный probe-результат кэшируется так же, как позитивный (TTL 30 с):
 * задержка обнаружения только что поднятого рантайма ≤30 с — осознанный
 * компромисс, чтобы не долбить лежащий рантайм на каждый /api/models и
 * каждый локальный ход. Single-flight: параллельные probe ждут один fetch.
 *
 * Ошибки — паттерн RagUnavailableError (rerank.ts): Unavailable = рантайм
 * или модель недоступны (наверху мапится в 503), Error = сбой уже начавшейся
 * генерации (в chat.ts уходит в существующий upstream_error-контракт).
 */

/** День 29 (proposals 261010 §3.1-1): per-entry параметры тюнинга — окно
 * контекста ходки и бюджет retrieved-контекста в промпте. 0.5b — профиль
 * дня 28 (2048/1000, прод VPS 1,9 ГБ RAM без изменений); 1.5b — расширенный
 * (4096/2000: KV ≈100–110 МБ, в контекст 3–6 кусков вместо 1–2). */
export interface LocalLlmTuning {
  readonly numCtx: number;
  readonly ragPromptTokenBudget: number;
}

export interface LocalLlmCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Порог по ВСЕЙ RAM машины (os.totalmem), МБ (D-26-4). */
  readonly minTotalRamMb: number;
  /** Размер весов — для бейджа в UI, МБ. */
  readonly sizeMb: number;
  /** День 29: параметры тюнинга генерации/контекста (per-entry). */
  readonly tuning: LocalLlmTuning;
}

export const LOCAL_LLM_CATALOG: readonly LocalLlmCatalogEntry[] = [
  {
    id: "qwen2.5:0.5b",
    label: "Qwen2.5 0.5B",
    minTotalRamMb: 1500,
    sizeMb: 400,
    tuning: { numCtx: 2048, ragPromptTokenBudget: 1000 },
  },
  {
    id: "qwen2.5:1.5b",
    label: "Qwen2.5 1.5B",
    minTotalRamMb: 4000,
    sizeMb: 1000,
    tuning: { numCtx: 4096, ragPromptTokenBudget: 2000 },
  },
  {
    id: "qwen2.5:3b",
    label: "Qwen2.5 3B",
    minTotalRamMb: 7000,
    sizeMb: 1900,
    tuning: { numCtx: 4096, ragPromptTokenBudget: 2000 },
  },
];

/** Дефолт каталога — его же использует npm run local-llm:check без --model. */
export const LOCAL_LLM_DEFAULT_MODEL = "qwen2.5:0.5b";

export function isLocalCatalogId(id: string): boolean {
  return LOCAL_LLM_CATALOG.some((entry) => entry.id === id);
}

/** Тюнинг-профиль модели; неизвестный id — консервативный дефолт дня 28
 * (num_ctx 2048 / бюджет 1000): каталог приходит открытой строкой в
 * overrides, dispatch выше уже отфильтровал неизвестные id. */
export function localLlmTuning(model: string): LocalLlmTuning {
  return (
    LOCAL_LLM_CATALOG.find((entry) => entry.id === model)?.tuning ?? {
      numCtx: 2048,
      ragPromptTokenBudget: 1000,
    }
  );
}

export interface LocalLlmConfig {
  baseUrl: string;
  timeoutMs: number;
  enabled: boolean;
}

/** env.ts держит переменные optional (день-23 паттерн) — дефолты живут здесь. */
export function localLlmConfig(env: Env): LocalLlmConfig {
  const kill = env.LOCAL_LLM_ENABLED;
  return {
    baseUrl: (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    timeoutMs: env.OLLAMA_TIMEOUT_MS ?? 120_000,
    // Kill-switch (D-26-1, паттерн RAG_RERANK_ENABLED rerank.ts:185):
    // "0"/"false" → всё недоступно, никаких обращений к рантайму.
    enabled: !(kill === "0" || (kill ?? "").toLowerCase() === "false"),
  };
}

export class LocalLlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLlmUnavailableError";
  }
}

export class LocalLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLlmError";
  }
}

// --- probe ------------------------------------------------------------------

export interface LocalLlmProbeEntry {
  id: string;
  label: string;
  sizeMb: number;
  installed: boolean;
  fitsRam: boolean;
  available: boolean;
}

export interface LocalLlmProbe {
  runtimeOk: boolean;
  enabled: boolean;
  totalRamMb: number;
  entries: LocalLlmProbeEntry[];
}

const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_500;

let probeCache: { baseUrl: string; at: number; value: LocalLlmProbe } | null =
  null;
let probePending: Promise<LocalLlmProbe> | null = null;

export async function probeLocalLlm(env: Env): Promise<LocalLlmProbe> {
  const { baseUrl, enabled } = localLlmConfig(env);
  if (
    probeCache &&
    probeCache.baseUrl === baseUrl &&
    Date.now() - probeCache.at < PROBE_TTL_MS
  ) {
    return probeCache.value;
  }
  // Single-flight: пока первый probe в полёте, остальные ждут тот же fetch.
  if (!probePending) {
    probePending = runProbe(baseUrl, enabled).finally(() => {
      probePending = null; // следующий вызов после TTL/start — свежий probe
    });
  }
  const value = await probePending;
  probeCache = { baseUrl, at: Date.now(), value };
  return value;
}

async function runProbe(
  baseUrl: string,
  enabled: boolean,
): Promise<LocalLlmProbe> {
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  // Kill-switch ведёт себя как «рантайм недоступен» (день-23): null →
  // runtimeOk:false, available:false у всех записей, fetch не делается.
  const installed = enabled ? await fetchInstalledModels(baseUrl) : null;
  return {
    runtimeOk: installed !== null,
    enabled,
    totalRamMb,
    entries: LOCAL_LLM_CATALOG.map((entry) => {
      const fitsRam = totalRamMb >= entry.minTotalRamMb;
      const has = installed?.has(entry.id) === true;
      return {
        id: entry.id,
        label: entry.label,
        sizeMb: entry.sizeMb,
        installed: has,
        fitsRam,
        available: installed !== null && has && fitsRam,
      };
    }),
  };
}

/** null = рантайм недоступен (таймаут/не-2xx/битый JSON); иначе имена моделей. */
async function fetchInstalledModels(
  baseUrl: string,
): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(json.models) ? json.models : [];
    const names = new Set<string>();
    for (const m of models) {
      if (typeof m.name === "string" && m.name.length > 0) names.add(m.name);
    }
    return names;
  } catch {
    return null;
  }
}

// --- chat stream ------------------------------------------------------------

/** Системный промпт локальной ветки — константа сервиса (design §2.1):
 * малая модель в честном режиме — инструменты и FSM-инжекты не подмешиваются.
 * Экспорт — скрипт сравнения дня 28 (compare-local-rag.ts) даёт облачному
 * arm'у ТОТ ЖЕ промпт+контекст, чтобы армы отличались только генератором. */
export const LOCAL_LLM_SYSTEM_PROMPT =
  "Ассистент Trigger Helper — приложения самопомощи по триггерным точкам. Отвечай кратко, по делу, на русском языке.";

/** День 29 (proposals 261010 §3.1-2): промпт под конкретный кейс — RAG-ответ
 * по базе триггерных точек; включается при наличии retrieved-контекста.
 * Вывод Кости дня 28: ответы «кратко» хуже для кейса — нужны 2–4 предложения
 * с конкретикой и жёсткая опора на блок ДАННЫХ (анти-галлюцинации малой
 * модели, день 24 в локальной ветке). */
export const LOCAL_LLM_RAG_PROMPT =
  "Ассистент Trigger Helper — приложения самопомощи по триггерным точкам. Ниже в блоке «ДАННЫЕ» — фрагменты базы знаний по триггерным точкам. Отвечай на вопрос ТОЛЬКО по этим фрагментам: называй мышцу, технику и симптомы конкретно, как в базе. Ответ — 2–4 предложения на русском языке. Чего нет во фрагментах — не выдумывай; если данных не хватает, скажи об этом прямо.";

/** День 29 (proposals 261010 §3.1-1): параметры генерации (глобальные для
 * всех локальных моделей). Температура 0.2 — прямой ответ грабле day26 (на
 * дефолтных 0.8 модель теряла «не» и путала мышцы); num_predict 320 —
 * потолок ответа «2–4 предложения» (max tokens задания), защита от
 * разгонов при неограниченном дефолте рантайма. */
export const LOCAL_LLM_TEMPERATURE = 0.2;
export const LOCAL_LLM_NUM_PREDICT = 320;

/** Override-форма (camelCase): замена профиля ПО ЗАДАННЫМ ПОЛЯМ — поля не
 * указаны → в Ollama не едут (дефолт рантайма). Baseline-arm скрипта
 * local-llm:tune передаёт {numCtx: 2048} — wire-формат дня 28 без
 * temperature/num_predict. */
export interface LocalLlmOptionsOverride {
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
}

/** Wire-options Ollama (snake_case, только заданные поля). Без override —
 * тюнинг-профиль дня 29: темп 0.2 + num_predict 320 + num_ctx каталога. */
export function localLlmWireOptions(
  model: string,
  override?: LocalLlmOptionsOverride,
): { temperature?: number; num_ctx?: number; num_predict?: number } {
  const src: LocalLlmOptionsOverride = override ?? {
    temperature: LOCAL_LLM_TEMPERATURE,
    numCtx: localLlmTuning(model).numCtx,
    numPredict: LOCAL_LLM_NUM_PREDICT,
  };
  const wire: { temperature?: number; num_ctx?: number; num_predict?: number } =
    {};
  if (src.temperature !== undefined) wire.temperature = src.temperature;
  if (src.numCtx !== undefined) wire.num_ctx = src.numCtx;
  if (src.numPredict !== undefined) wire.num_predict = src.numPredict;
  return wire;
}

export interface LocalLlmChatParams {
  model: string;
  q: string;
  /** День 27: история диалога (contextTail → localHistoryTurns, капы ниже). */
  history?: LocalLlmHistoryTurn[];
  /** День 28: retrieved-контекст (localRagRetrieve.contextBlock, SEC-F3) —
   * дописывается в system-промпт ПОСЛЕ базового (данные, не инструкции). */
  context?: string;
  /** День 29: базовый системный промпт (скрипт local-llm:tune: baseline-arm
   * воспроизводит день 28 старым промптом). По умолчанию — RAG-промпт при
   * наличии context, иначе базовый. */
  systemPrompt?: string;
  /** День 29: замена тюнинг-профиля options (см. LocalLlmOptionsOverride). */
  options?: LocalLlmOptionsOverride;
}

/** System-сообщение ходки: базовый промпт (override → RAG-промпт при
 * контексте → базовый) + SEC-F3-блок контекста после него. Экспорт —
 * юнит-тест и скрипт local-llm:tune (сборка system без ходки). */
export function localSystemPrompt(
  params: Pick<LocalLlmChatParams, "systemPrompt" | "context">,
): string {
  const base =
    params.systemPrompt ??
    (params.context ? LOCAL_LLM_RAG_PROMPT : LOCAL_LLM_SYSTEM_PROMPT);
  return params.context ? `${base}\n\n${params.context}` : base;
}

/** Роль сообщения истории — контракту ChatTraceSchema.historyMessages отвечает. */
export interface LocalLlmHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Капы истории локальной ветки под num_ctx 2048 (proposals 261009 §3.1):
 * system ≈40 ток + история ≤1500 симв (~500–700 ток) + вопрос + ответ —
 * с запасом; общие капы normalizeContextTail для 2048 не годятся. */
const LOCAL_HISTORY_MAX_MESSAGES = 6;
const LOCAL_HISTORY_MESSAGE_CHARS = 400;
const LOCAL_HISTORY_TOTAL_CHARS = 1500;

/** День 27: клиентский contextTail → история локальной ходки. Последние
 * сообщения диалога, per-message клип, суммарный бюджет — старейшие
 * отрезаются первыми. Экспорт для чек-скрипта и прямых юнит-проверок. */
export function localHistoryTurns(
  tail: ChatContextTail | undefined,
): LocalLlmHistoryTurn[] {
  const recent = (tail?.dialogue ?? []).slice(-LOCAL_HISTORY_MAX_MESSAGES);
  const clipped = recent.map((m) => ({
    role: m.role,
    content: clip(m.content, LOCAL_HISTORY_MESSAGE_CHARS),
  }));
  let total = clipped.reduce((a, m) => a + m.content.length, 0);
  while (total > LOCAL_HISTORY_TOTAL_CHARS && clipped.length > 0) {
    total -= clipped[0]!.content.length;
    clipped.shift();
  }
  return clipped;
}

// --- День 28: детерминированный RAG-retrieval локальной ветки -------------

/** Локальный бюджет (proposals 261009 §3.1-1): num_ctx 2048 ⇒ контекст
 * ≤~1000 токенов и k≈6. Облачные 3k/16 (answer.ts) не переиспользуются. */
const LOCAL_RAG_K_FINAL = 6;
const LOCAL_RAG_PROMPT_TOKEN_BUDGET = 1_000;
/** Индекс по умолчанию — тот же, что у облачного пути (rag-tool.ts: structured). */
const LOCAL_RAG_STRATEGY = "structured";

/** Результат retrieval-этапа локальной ветки: контекст для промпта + факты
 * для rag-пейлоада трейса (та же форма полей, что у облачного rag_ask). */
export interface LocalRagRetrieval {
  /** SEC-F3 data-блок retrieved-кусков (LocalLlmChatParams.context); "" при dontKnow. */
  contextBlock: string;
  sources: RagAskSource[];
  /** Косинус top-1 ДО реранка — метрика dontKnow-гейта (как у облака, D-4). */
  topCosine: number;
  /** Порог из tune-dontknow.json; null = артефакт бит/отсутствует → гейт выключен. */
  threshold: number | null;
  poolRanked: number;
  keptAfterFilter: number;
  injectedCount: number;
  rerankLatencyMs: number;
  latencyMs: number;
  dontKnow: boolean;
  /** День 29: ПОСЛЕ-реранк список hits — скрипт local-llm:tune собирает из
   * одного ranking+rerank контексты разных бюджетов (baseline 1000 ток)
 * без повторного реранка. */
  rerankedHits: SearchHit[];
}

/** Копия схемы артефакта answer.ts:621 (приватной там; скоуп дня 28 облачный
 * файл не трогает) — порог один и тот же, доверие одинаковое (коммичено). */
const localDontKnowArtifactSchema = z.object({
  builtAt: z.string().min(1),
  threshold: z.object({
    value: z.number().min(0).max(1),
    kind: z.enum(["gap-midpoint", "conservative"]),
  }),
});

/** Зеркало loadDontKnowThreshold (answer.ts:632): пере-чтение без кеша,
 * safeParse, warn + гейт-off — битый артефакт не превращает ход в 503. */
async function loadLocalDontKnowThreshold(): Promise<number | null> {
  try {
    const raw = await fs.readFile(
      path.join(repoRoot, "data", "rag", "tune-dontknow.json"),
      "utf8",
    );
    const parsed = localDontKnowArtifactSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("[local-llm] tune-dontknow.json schema mismatch — dontKnow-гейт выключен");
      return null;
    }
    return parsed.data.threshold.value;
  } catch {
    console.warn("[local-llm] tune-dontknow.json отсутствует — dontKnow-гейт выключен");
    return null;
  }
}

/** Canned-ответ гейта — дословно шаблон дня 24 (answer.ts dontKnowAnswer,
 * приватна; фидбек 041004: вопрос вшит в отказ, чтобы модель не приписывала
 * «в базе нет» соседнему вопросу истории). */
export function localDontKnowAnswer(q: string): string {
  return `Не знаю — по запросу «${q.slice(0, 120)}» в базе знаний нет ничего релевантного. Уточните вопрос (мышца, симптом, техника)?`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** День 28 (proposals 261009 §3.1-1): конвейер облака минус облачные шаги —
 * rankByQueries (ОДИН запрос, без rewrite — rewrite облачный) → dontKnow-гейт
 * по косинус top-1 (tune-dontknow.json) → локальный кросс-энкодер реранк
 * (порог tune-rerank.json внутри rerank()) → сборка контекста с ЛОКАЛЬНЫМ
 * бюджетом. Сборка — greedy whole-chunk по паттерну облачной assembleContext
 * (D-3): чанк не режется, хвост выбрасывается первым, первый чанк остаётся
 * всегда. Детерминированно: тулз-лупа/FSM у 0.5b/1.5b нет.
 *
 * onPhase (cust-fix 10.10): прогресс-фазы конвейера для живого таймера шага
 * «Поиск по базе» — ретривал без событий выглядит как зависание.
 *
 * dontKnowGate:false (скрипт сравнения дня 28) — гейт пропускается, «что
 * вернул поиск — то и в контексте». Реранкер, выключенный на хосте
 * (prod: RAG_RERANK_ENABLED=0 — 544 МиБ не влезают рядом с 0.5b), — деградация
 * в base (топ-k по косинусу), как облачный путь на этом хосте; остальные
 * ошибки конвейера (нет индекса и т.п.) — RagUnavailableError наверх:
 * у пресета, обещающего RAG, тихая деградация «без базы» была бы нечестной
 * (fail-closed). */
/** Русская плюрализация для фазы реранка (24 → «фрагмента», 40 → «фрагментов»). */
function pluralFragments(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return "фрагментов";
  if (b > 1 && b < 5) return "фрагмента";
  if (b === 1) return "фрагмент";
  return "фрагментов";
}

export async function localRagRetrieve(
  rag: RagService,
  reranker: Reranker,
  q: string,
  opts: {
    dontKnowGate?: boolean;
    onPhase?: (text: string) => void;
    /** День 29: override k/бюджета сборки (по умолчанию — константы дня 28;
     * продуктовый путь chat.ts передаёт бюджет профиля модели). */
    k?: number;
    promptTokenBudget?: number;
  } = {},
): Promise<LocalRagRetrieval> {
  const t0 = Date.now();
  const ranked = await rag.rankByQueries([q], LOCAL_RAG_STRATEGY);
  const topCosine = round4(ranked.hits[0]?.score ?? 0);
  const poolRanked = ranked.hits.length;

  const threshold = await loadLocalDontKnowThreshold();
  if (
    opts.dontKnowGate !== false &&
    threshold !== null &&
    topCosine < threshold
  ) {
    return {
      contextBlock: "",
      sources: [],
      topCosine,
      threshold,
      poolRanked,
      keptAfterFilter: 0,
      injectedCount: 0,
      rerankLatencyMs: 0,
      latencyMs: Date.now() - t0,
      dontKnow: true,
      rerankedHits: [],
    };
  }

  let hits = ranked.hits;
  let keptAfterFilter = poolRanked;
  let rerankLatencyMs = 0;
  // Реранк — самая долгая фаза (CPU, десятки секунд): сообщаем её старт,
  // чтобы шаг «Поиск по базе» не молчал (cust-fix 10.10 «г»). Число — ЧЕСТНЫЙ
  // размер пула кросс-энкодера из артефакта (хвост 11.10, замечание Кости:
  // раньше показывали весь косинус-пул poolRanked=262, а реранкер читает
  // только топ-pool — 24 с 11.10); null = реранкер выключен (base-режим VPS).
  const rerankPool = await reranker.rerankPoolSize();
  opts.onPhase?.(
    rerankPool != null
      ? `Уточняю релевантность ${rerankPool} ${pluralFragments(rerankPool)}…`
      : "Уточняю релевантность…",
  );
  try {
    const reranked = await reranker.rerank(q, ranked.hits);
    hits = reranked.hits;
    keptAfterFilter = reranked.kept;
    rerankLatencyMs = reranked.latencyMs;
  } catch (err) {
    // Prod-реальность (смок 09.10): RAG_RERANK_ENABLED=0 на VPS. Деградация
    // в base — топ-k по косинусу эмбеддингов; честно видно в трейсе
    // (rerankLatencyMs 0, keptAfterFilter = poolRanked). Остальное — наверх.
    if (!(err instanceof RagUnavailableError)) throw err;
    console.warn("[local-llm] reranker недоступен — base-retrieval (топ-k по косинусу)");
  }

  const assembly = localRagAssemble(hits, {
    k: opts.k,
    promptTokenBudget: opts.promptTokenBudget,
  });
  return {
    ...assembly,
    topCosine,
    threshold,
    poolRanked,
    keptAfterFilter,
    rerankLatencyMs,
    latencyMs: Date.now() - t0,
    dontKnow: false,
    rerankedHits: hits,
  };
}

/** День 29: сборка SEC-F3-блока контекста из ранжированных hits — выделена
 * из localRagRetrieve, чтобы скрипт local-llm:tune собирал из ОДНОГО
 * ranking+rerank контексты разных бюджетов (baseline 1000 / tuned 2000)
 * без повторного реранка. Жадная whole-chunk сборка (D-3 дня 28): чанк
 * не режется, хвост выбрасывается первым, первый чанк остаётся всегда. */
export interface LocalRagAssembly {
  contextBlock: string;
  sources: RagAskSource[];
  injectedCount: number;
}

export function localRagAssemble(
  hits: readonly SearchHit[],
  opts: { k?: number; promptTokenBudget?: number } = {},
): LocalRagAssembly {
  const k = opts.k ?? LOCAL_RAG_K_FINAL;
  const budget = opts.promptTokenBudget ?? LOCAL_RAG_PROMPT_TOKEN_BUDGET;
  const kept: { text: string; source: RagAskSource }[] = [];
  let tokens = 0;
  for (const { chunk, score } of hits.slice(0, k)) {
    const header = `[${chunk.source} | ${chunk.section || "—"} | ${chunk.chunk_id}]`;
    const text = `${header}\n${chunk.text.trim()}`;
    const candidateTokens = estimateTokens(text) + (kept.length ? 2 : 0);
    if (kept.length > 0 && tokens + candidateTokens > budget) {
      break;
    }
    kept.push({
      text,
      source: {
        chunk_id: chunk.chunk_id,
        score: round4(score),
        source: chunk.source,
        file: chunk.file,
        title: chunk.title,
        section: chunk.section,
      },
    });
    tokens += candidateTokens;
  }

  const body = kept.map((p) => p.text).join("\n\n---\n\n");
  return {
    contextBlock: body ? buildContextDataBlock("база знаний", body) : "",
    sources: kept.map((p) => p.source),
    injectedCount: kept.length,
  };
}

export interface LocalLlmChatResult {
  reply: string;
  /** prompt_eval_count финального NDJSON-кадра (0, если рантайм не отдал). */
  promptTokens: number;
  /** eval_count финального NDJSON-кадра (0, если рантайм не отдал). */
  completionTokens: number;
  totalMs: number;
}

interface OllamaChatChunk {
  message?: { content?: unknown };
  done?: boolean;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Одна ходка в Ollama POST /api/chat со стримом. onDelta получает каждую
 * NDJSON-дельту message.content (в chat.ts это кормит счётчик прогресса
 * `local-gen`); токены и латентность — из финального кадра (eval_count).
 */
export async function chatLocalLlm(
  env: Env,
  { model, q, history, context, systemPrompt, options }: LocalLlmChatParams,
  onDelta?: (delta: string) => void,
): Promise<LocalLlmChatResult> {
  const { baseUrl, timeoutMs } = localLlmConfig(env);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            // День 28: retrieved-контекст едет в system делимитерами
            // «данные, не инструкции» (SEC-F3) — после базового промпта.
            // День 29: базовый промпт — под кейс (RAG-промпт при контексте),
            // если не передан override (baseline-arm скрипта local-llm:tune).
            content: localSystemPrompt({ systemPrompt, context }),
          },
          ...(history ?? []).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: q },
        ],
        stream: true,
        // День 29 (proposals 261010 §3.1-1): тюнинг-профиль — темп 0.2 /
        // num_predict 320 / num_ctx из каталога (0.5b: 2048 — прод VPS без
        // изменений; 1.5b: 4096 ⇒ KV ≈100–110 МБ). День 28 (без профиля):
        // только {num_ctx: 2048}, температура/длина — дефолты рантайма.
        options: localLlmWireOptions(model, options),
      }),
      // OLLAMA_TIMEOUT_MS — общий потолок ходки (дефолт 120 с < дефолтов
      // undici, отдельной конфигурации транспорта не нужно).
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LocalLlmUnavailableError(
      `Локальный рантайм Ollama (${baseUrl}) недоступен: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new LocalLlmUnavailableError(
      `Ollama /api/chat вернула ${res.status}${
        detail ? `: ${clip(detail.trim(), 300)}` : ""
      }`,
    );
  }

  // Ручной NDJSON-парсер (design §2.1): буфер держит хвост строки между
  // чанками — TextDecoder(stream:true), сплит по "\n", флаш остатка в конце.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let promptTokens = 0;
  let completionTokens = 0;

  const handleLine = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    let chunk: OllamaChatChunk;
    try {
      chunk = JSON.parse(line) as OllamaChatChunk;
    } catch {
      throw new LocalLlmError(
        `Ollama: некорректная NDJSON-строка: ${clip(line, 120)}`,
      );
    }
    if (typeof chunk.error === "string" && chunk.error.length > 0) {
      throw new LocalLlmError(`Ollama: ${chunk.error}`);
    }
    const content = chunk.message?.content;
    if (typeof content === "string" && content.length > 0) {
      reply += content;
      onDelta?.(content);
    }
    if (chunk.done === true) {
      if (typeof chunk.prompt_eval_count === "number") {
        promptTokens = chunk.prompt_eval_count;
      }
      if (typeof chunk.eval_count === "number") {
        completionTokens = chunk.eval_count;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode(); // флаш хвоста без завершающего "\n"
    handleLine(buffer);
  } catch (err) {
    if (err instanceof LocalLlmError) throw err;
    throw new LocalLlmError(
      `Стрим Ollama оборвался: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    // рельса ревью M1: при падении стрима не держать сокет до таймаута
    reader.cancel().catch(() => {});
  }

  return { reply, promptTokens, completionTokens, totalMs: Date.now() - t0 };
}
