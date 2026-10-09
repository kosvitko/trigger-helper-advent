import os from "node:os";
import type { ChatContextTail } from "@trigger-helper/shared";
import type { Env } from "../config/env.js";

/**
 * День 26 — локальная LLM в продукте (design §2.1, D-26-1/3/4).
 * День 27 — история диалога (proposals 261009 §3.1): ходка принимает history
 * (клиентский contextTail через localHistoryTurns с локальными капами) —
 * messages = system + history + user; trace.historyMessages — evidence.
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

export interface LocalLlmCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** Порог по ВСЕЙ RAM машины (os.totalmem), МБ (D-26-4). */
  readonly minTotalRamMb: number;
  /** Размер весов — для бейджа в UI, МБ. */
  readonly sizeMb: number;
}

export const LOCAL_LLM_CATALOG: readonly LocalLlmCatalogEntry[] = [
  { id: "qwen2.5:0.5b", label: "Qwen2.5 0.5B", minTotalRamMb: 1500, sizeMb: 400 },
  { id: "qwen2.5:1.5b", label: "Qwen2.5 1.5B", minTotalRamMb: 4000, sizeMb: 1000 },
  { id: "qwen2.5:3b", label: "Qwen2.5 3B", minTotalRamMb: 7000, sizeMb: 1900 },
];

/** Дефолт каталога — его же использует npm run local-llm:check без --model. */
export const LOCAL_LLM_DEFAULT_MODEL = "qwen2.5:0.5b";

export function isLocalCatalogId(id: string): boolean {
  return LOCAL_LLM_CATALOG.some((entry) => entry.id === id);
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
 * малая модель в честном режиме — инструменты и FSM-инжекты не подмешиваются. */
const LOCAL_LLM_SYSTEM_PROMPT =
  "Ассистент Trigger Helper — приложения самопомощи по триггерным точкам. Отвечай кратко, по делу, на русском языке.";

export interface LocalLlmChatParams {
  model: string;
  q: string;
  /** День 27: история диалога (contextTail → localHistoryTurns, капы ниже). */
  history?: LocalLlmHistoryTurn[];
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
  { model, q, history }: LocalLlmChatParams,
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
          { role: "system", content: LOCAL_LLM_SYSTEM_PROMPT },
          ...(history ?? []).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: q },
        ],
        stream: true,
        // num_ctx 2048 ⇒ KV ≈48–56 МБ + веса ≈0.6–0.8 ГБ RSS (design §2.1).
        options: { num_ctx: 2048 },
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
