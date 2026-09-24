import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Point } from "@trigger-helper/shared";
import type { PointsService } from "./points.js";

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
] as const;

export type OwnMcpToolName = (typeof OWN_MCP_TOOL_SCHEMAS)[number]["name"];

function toolText(payload: unknown): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function createOwnMcpServer(pointsService: PointsService): McpServer {
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
  opts: { pointsService: PointsService },
): Promise<void> {
  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createOwnMcpServer(opts.pointsService);
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
