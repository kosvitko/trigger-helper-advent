/**
 * Типизированный REST-клиент SPA (P0-подмножество, design §3.1).
 * C+ CH-6 (D-10): stateful-обёртки (instances, /api/agent/run, messages,
 * chat-task-state, close/restore) сняты вместе с серверными роутами — ход
 * диалога идёт через api-chat.ts (stateless POST /api/chat, SSE); остались
 * только справочники. День 26: схема /api/models — СОВМЕСТНАЯ (shared
 * schemas/models.ts), не локальная: локальный zod strip-ал бы новую
 * local-секцию каталога локальных моделей (D-26-4), и она молча не дошла
 * бы до UI (04-MED-3).
 */
import { z } from "zod";
import { ModelsResponseSchema } from "@trigger-helper/shared";

/** Ошибка API: текст для пользователя + статус + сырое тело. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Дефолтный таймаут запроса: зависший fetch ≠ «молча пустой UI» (баг 1). */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Низкоуровневый fetch: JSON туда/обратно, не-2xx → ApiError. */
async function request(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError"
      ? `Сервер не ответил за ${Math.round(timeoutMs / 1000)} с`
      : "Сервер недоступен";
    throw new ApiError(msg, 0, e);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/** Парс ответа схемой; расхождение контракта → явная ошибка, не «мусор в UI».
 *  Структурная сигнатура (safeParse → T), а не z.ZodType<T>: у схем с .default()
 *  Input ≠ Output, и вариантность ZodType ломает вывод типов. */
function parseWith<T>(schema: { safeParse: (data: unknown) => z.SafeParseReturnType<unknown, T> }, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError("Неожиданный формат ответа сервера", 502, r.error);
  }
  return r.data;
}

/** Элемент models[] ответа /api/models (после трима 04.10 — только поля SPA). */
export type ModelInfo = ModelsResponse["models"][number];

/** GET /api/rag/stats — статистика индексов и контрольные прогоны (read-only). */
const RagStatsResponseSchema = z.object({
  ok: z.boolean(),
  indexes: z.array(
    z.object({
      strategy: z.string(),
      model: z.string(),
      chunks: z.number(),
      fileCount: z.number(),
      builtAt: z.string().optional(),
      avgChars: z.number().optional(),
    }),
  ),
  compare: z
    .object({
      byStrategy: z.record(
        z.string(),
        z.object({
          hitAt1: z.number().optional(),
          hitAt5: z.number().optional(),
          mrr: z.number().optional(),
        }),
      ),
    })
    .optional(),
});

/** GET /api/agents — метa-справочник; настройкам нужен дефолт автосжатия
 * (QA 041004: поле «Автосжатие» рисовалось пустым — override не задан,
 * а серверный дефолт UI не знал). Остальные поля ответа стриппаются zod'ом. */
const AgentsMetaResponseSchema = z.object({
  autoCompress: z.object({ defaultEvery: z.number().int() }).optional(),
});

export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const api = {
  async getModels(): Promise<ModelsResponse> {
    return parseWith(ModelsResponseSchema, await request("/api/models"));
  },

  /** GET /api/agents — справочник пресетов/дефолтов (нужен defaultEvery). */
  async agentsMeta(): Promise<z.infer<typeof AgentsMetaResponseSchema>> {
    return parseWith(AgentsMetaResponseSchema, await request("/api/agents"));
  },

  /** GET /api/rag/stats — read-only статистика индексов (экран настроек). */
  async ragStats(): Promise<z.infer<typeof RagStatsResponseSchema>> {
    return parseWith(RagStatsResponseSchema, await request("/api/rag/stats"));
  },
};
