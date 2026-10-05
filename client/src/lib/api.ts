/**
 * Типизированный REST-клиент SPA (P0-подмножество, design §3.1).
 * Zod-схемы — из @trigger-helper/shared, где контракт экспортирован
 * (agent-контракты); обёртки ответов и неэкспортированные роуты
 * (models/health) — локальные схемы (02b-F-9).
 */
import { z } from "zod";
import {
  AddAgentRequestSchema,
  AgentInstanceSchema,
  AgentMessageSchema,
  AgentRunResponseSchema,
  ChatTaskStateSchema,
  CreateInstanceRequestSchema,
  InstanceSchema,
} from "@trigger-helper/shared";
import type {
  AddAgentRequest,
  AgentInstance,
  AgentMessage,
  AgentRunRequest,
  AgentRunResponse,
  ChatTaskState,
  ChatTaskStatePatch,
  CreateInstanceRequest,
  Instance,
} from "@trigger-helper/shared";

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

/** Дефолтный таймаут запроса: зависший fetch ≠ «молча пустой UI» (баг 1).
 *  Для LLM-хода — свой, длинный (см. runAgent). */
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

/* — Локальные схемы роутов, которых нет в shared (обёртки ответов сервера) — */

const InstancesResponseSchema = z.object({
  instances: z.array(InstanceSchema),
  caps: z.object({
    maxInstances: z.number(),
    maxAgentsPerInstance: z.number(),
    usedInstances: z.number().optional(),
  }),
});

const CreateInstanceResponseSchema = z.object({ instance: InstanceSchema });

const AddAgentResponseSchema = z.object({ agent: AgentInstanceSchema });

const ThreadResponseSchema = z.object({
  instanceId: z.string(),
  agentId: z.string(),
  threadAgentId: z.string(),
  messages: z.array(AgentMessageSchema),
  facts: z.record(z.string(), z.string()),
  branch: z.object({
    forked: z.boolean(),
    activeBranchId: z.string().nullable(),
    checkpointCount: z.number(),
  }),
  contextStrategy: z.string().nullable(),
});

const ModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      tier: z.string(),
      label: z.string(),
      model: z.string(),
      via: z.string(),
    }),
  ),
});

/** Элемент models[] ответа /api/models (после трима 04.10 — только поля SPA). */
export type ModelInfo = z.infer<typeof ModelsResponseSchema>["models"][number];

const ChatTaskStateResponseSchema = z.object({ chatTaskState: ChatTaskStateSchema });

/* — Закрытие чата/инстанса + «Вернуть» (старый UI, agents.ts:164–253) — */

const CloseAgentResponseSchema = z.object({
  agent: AgentInstanceSchema,
  messages: z.array(AgentMessageSchema),
});

const CloseInstanceResponseSchema = z.object({
  instance: InstanceSchema,
  threads: z.record(z.string(), z.array(AgentMessageSchema)),
});

const HealthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
});

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

export type InstancesResponse = z.infer<typeof InstancesResponseSchema>;
export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const api = {
  /** Ход диалога: run-payload несёт всё для трейса (agents.ts:932–960). */
  async runAgent(req: AgentRunRequest): Promise<AgentRunResponse> {
    return parseWith(
      AgentRunResponseSchema,
      await request(
        "/api/agent/run",
        {
          method: "POST",
          body: JSON.stringify(req),
        },
        180_000, // LLM-ход небыстрый: таймаут хода ≠ таймаут справочников
      ),
    );
  },

  async listInstances(): Promise<InstancesResponse> {
    return parseWith(InstancesResponseSchema, await request("/api/instances"));
  },

  async createInstance(req?: CreateInstanceRequest): Promise<z.infer<typeof CreateInstanceResponseSchema>> {
    return parseWith(
      CreateInstanceResponseSchema,
      await request("/api/instances", {
        method: "POST",
        body: JSON.stringify(CreateInstanceRequestSchema.parse(req ?? {})),
      }),
    );
  },

  async addAgent(
    instanceId: string,
    req: AddAgentRequest,
  ): Promise<z.infer<typeof AddAgentResponseSchema>> {
    return parseWith(
      AddAgentResponseSchema,
      await request(`/api/instances/${encodeURIComponent(instanceId)}/agents`, {
        method: "POST",
        body: JSON.stringify(AddAgentRequestSchema.parse(req)),
      }),
    );
  },

  async listMessages(instanceId: string, agentId: string): Promise<ThreadResponse> {
    return parseWith(
      ThreadResponseSchema,
      await request(
        `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}/messages`,
      ),
    );
  },

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

  async getChatTaskState(instanceId: string, agentId: string): Promise<ChatTaskState> {
    const r = parseWith(
      ChatTaskStateResponseSchema,
      await request(
        `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}/chat-task-state`,
      ),
    );
    return r.chatTaskState;
  },

  async patchChatTaskState(
    instanceId: string,
    agentId: string,
    patch: ChatTaskStatePatch,
  ): Promise<ChatTaskState> {
    const r = parseWith(
      ChatTaskStateResponseSchema,
      await request(
        `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}/chat-task-state`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    );
    return r.chatTaskState;
  },

  async health(): Promise<HealthResponse> {
    return parseWith(HealthResponseSchema, await request("/api/health"));
  },

  /** Закрыть чат (агента): DELETE возвращает снапшот для «Вернуть». */
  async closeAgent(instanceId: string, agentId: string): Promise<z.infer<typeof CloseAgentResponseSchema>> {
    return parseWith(
      CloseAgentResponseSchema,
      await request(
        `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
      ),
    );
  },

  /** Восстановить закрытый чат на прежнюю позицию. */
  async restoreAgent(
    instanceId: string,
    snap: { agent: AgentInstance; messages: AgentMessage[]; index: number },
  ): Promise<z.infer<typeof CloseAgentResponseSchema>> {
    return parseWith(
      CloseAgentResponseSchema,
      await request(`/api/instances/${encodeURIComponent(instanceId)}/agents/restore`, {
        method: "POST",
        body: JSON.stringify(snap),
      }),
    );
  },

  /** Закрыть инстанс целиком (сессию); снапшот — для «Вернуть». */
  async closeInstance(instanceId: string): Promise<z.infer<typeof CloseInstanceResponseSchema>> {
    return parseWith(
      CloseInstanceResponseSchema,
      await request(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" }),
    );
  },

  /** Восстановить закрытый инстанс. */
  async restoreInstance(
    snap: { instance: Instance; threads: Record<string, AgentMessage[]> },
  ): Promise<z.infer<typeof CloseInstanceResponseSchema>> {
    return parseWith(
      CloseInstanceResponseSchema,
      await request("/api/instances/restore", {
        method: "POST",
        body: JSON.stringify(snap),
      }),
    );
  },
};
