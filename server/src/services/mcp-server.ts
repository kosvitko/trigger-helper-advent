import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Point } from "@trigger-helper/shared";
import type { PointsService } from "./points.js";
import type { SchedulerService } from "./scheduler.js";

/**
 * Day17: own MCP server around the product atlas — read-only PointsService.
 * Registered tools never call the LLM and never touch secrets (design TR-2).
 */

const ZONE_VALUES = ["head", "arm", "shoulder"] as const;

const listPointsShape = {
  zone: z
    .enum(ZONE_VALUES)
    .optional()
    .describe("Фильтр по зоне отражённой боли (не по локализации мышцы)"),
};

const getPointShape = {
  id: z.string().min(1).describe("id точки из list_points"),
};

// Day18: scheduler tools — schedule/cancel digest jobs, read the summary.
const scheduleJobShape = {
  query: z
    .string()
    .min(3)
    .max(120)
    .describe(
      "Запрос на английском для PubMed (русский не ищется), пример: massage therapy",
    ),
  every_sec: z
    .number()
    .int()
    .min(30)
    .max(86400)
    .describe("Интервал сбора в секундах (не чаще раза в 30 секунд)"),
  ttl_sec: z
    .number()
    .int()
    .min(60)
    .max(86400)
    .optional()
    .describe("Время жизни задачи в секундах, по умолчанию 86400 (сутки)"),
};

const cancelJobShape = {
  id: z.string().min(1).describe("id задачи из list_jobs или schedule_job"),
};

/**
 * JSON-Schema twins of the zod shapes above — the LLM-facing `tools` param
 * (llm-agent injects these into every tools-run request). One source of truth
 * per direction: zod here (SDK registerTool validates input), JSON Schema
 * there (DeepSeek function calling). Kept side by side so a change to one is
 * visible against the other.
 */
export const OWN_MCP_TOOL_SCHEMAS = [
  {
    name: "list_points",
    description:
      "Список триггерных точек атласа самопомощи с техниками и предостережениями; " +
      "опциональный фильтр по зоне отражённой боли (head — голова, arm — рука, shoulder — плечо/шея).",
    parameters: {
      type: "object",
      properties: {
        zone: {
          type: "string",
          enum: [...ZONE_VALUES],
          description: "Зона отражённой боли: head | arm | shoulder",
        },
      },
      required: [],
    },
  },
  {
    name: "get_point",
    description:
      "Одна триггерная точка атласа по id (id взять из list_points): имя, зоны боли, техника самомассажа, предостережения.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "id точки из list_points" },
      },
      required: ["id"],
    },
  },
  {
    name: "schedule_job",
    description:
      "Создать фоновую задачу периодического сбора публикаций PubMed по запросу. " +
      "query — НА АНГЛИЙСКОМ (PubMed не ищет по-русски), например: massage therapy. " +
      "Возвращает id задачи и время истечения TTL; сбор идёт сам по расписанию, " +
      "сводки появляются сами (см. get_summary).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 3,
          maxLength: 120,
          description:
            "Запрос на английском для PubMed, пример: massage therapy",
        },
        every_sec: {
          type: "integer",
          minimum: 30,
          maximum: 86400,
          description: "Интервал сбора в секундах (не чаще раза в 30 секунд)",
        },
        ttl_sec: {
          type: "integer",
          minimum: 60,
          maximum: 86400,
          description: "Время жизни задачи в секундах (по умолчанию 86400 = сутки)",
        },
      },
      required: ["query", "every_sec"],
    },
  },
  {
    name: "get_summary",
    description:
      "Последняя агрегированная сводка планировщика: дайджест публикаций PubMed " +
      "(свежие или из архива) + счётчики (сколько статей ждёт обработки, сколько тиков).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_jobs",
    description:
      "Список фоновых задач планировщика: запрос, интервал, следующий запуск, пропуски, активность.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_job",
    description: "Отменить фоновую задачу планировщика по id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "id задачи из list_jobs" },
      },
      required: ["id"],
    },
  },
] as const;

export type OwnMcpToolName = (typeof OWN_MCP_TOOL_SCHEMAS)[number]["name"];

function toolText(payload: unknown): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function createOwnMcpServer(
  pointsService: PointsService,
  scheduler: SchedulerService,
): McpServer {
  const server = new McpServer({
    name: "trigger-helper-atlas",
    version: "0.1.0",
  });

  server.registerTool(
    "list_points",
    {
      description: OWN_MCP_TOOL_SCHEMAS[0].description,
      inputSchema: listPointsShape,
    },
    async ({ zone }) => {
      const points = await pointsService.loadAll();
      const filtered = zone
        ? points.filter((p: Point) => p.pain_zones.includes(zone))
        : points;
      return toolText({
        count: filtered.length,
        points: filtered.map((p) => ({
          id: p.id,
          name: p.name,
          pain_zones: p.pain_zones,
          technique: p.technique,
          cautions: p.cautions,
        })),
      });
    },
  );

  server.registerTool(
    "get_point",
    {
      description: OWN_MCP_TOOL_SCHEMAS[1].description,
      inputSchema: getPointShape,
    },
    async ({ id }) => {
      const point = await pointsService.findById(id);
      if (!point) {
        return {
          ...toolText({ error: `Точка «${id}» не найдена — см. list_points` }),
          isError: true,
        };
      }
      return toolText({
        point: {
          id: point.id,
          name: point.name,
          pain_zones: point.pain_zones,
          technique: point.technique,
          cautions: point.cautions,
        },
      });
    },
  );

  // ---- Day18: scheduler tools (design §4.1; canon gate D-6) ----

  server.registerTool(
    "schedule_job",
    {
      description: OWN_MCP_TOOL_SCHEMAS[2].description,
      inputSchema: scheduleJobShape,
    },
    async ({ query, every_sec, ttl_sec }) => {
      try {
        const res = await scheduler.scheduleJob({
          query,
          everySec: every_sec,
          ttlSec: ttl_sec,
        });
        return toolText({ jobId: res.jobId, nextRunAt: res.nextRunAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...toolText({
            error:
              message === "job_cap_reached"
                ? "job_cap_reached"
                : `schedule_job failed: ${message}`,
          }),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_summary",
    {
      description: OWN_MCP_TOOL_SCHEMAS[3].description,
      inputSchema: {},
    },
    async () => {
      const snap = scheduler.snapshot();
      if (!snap.lastSummary) {
        return {
          ...toolText({ error: "no_summary_yet" }),
          isError: true,
        };
      }
      return toolText({
        summary: snap.lastSummary,
        counters: {
          pending: snap.counters.pending,
          digested: snap.counters.digested,
          ticks: snap.counters.ticks,
        },
      });
    },
  );

  server.registerTool(
    "list_jobs",
    {
      description: OWN_MCP_TOOL_SCHEMAS[4].description,
      inputSchema: {},
    },
    async () => {
      const snap = scheduler.snapshot();
      return toolText({
        jobs: snap.jobs.map((j) => ({
          id: j.id,
          query: j.query,
          every_sec: j.everySec,
          active: j.active,
          next_run_at: new Date(j.nextRunAt).toISOString(),
          last_run_at: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          missed: j.missed,
        })),
      });
    },
  );

  server.registerTool(
    "cancel_job",
    {
      description: OWN_MCP_TOOL_SCHEMAS[5].description,
      inputSchema: cancelJobShape,
    },
    async ({ id }) => {
      if (!scheduler.cancelJob(id)) {
        return { ...toolText({ error: "job_not_found" }), isError: true };
      }
      return toolText({ ok: true, id });
    },
  );

  return server;
}

/** Loopback URL of our own MCP endpoint (zero new env vars — from PORT). */
export function ownMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Stateless per-request pattern: a fresh server+transport pair per POST.
 * JSON responses only (no SSE leg) and no session bookkeeping; GET /mcp is
 * not registered (Fastify 404) — the recorder/VPS smoke pins that status.
 */
export async function registerOwnMcpRoute(
  app: FastifyInstance,
  opts: { pointsService: PointsService; scheduler: SchedulerService },
): Promise<void> {
  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createOwnMcpServer(opts.pointsService, opts.scheduler);
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, "own MCP endpoint failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
      }
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message },
        }),
      );
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
}
