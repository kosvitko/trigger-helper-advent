import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateTokens } from "../services/agent/token-estimate.js";
import { callMcpTool, listMcpTools } from "../services/mcp-client.js";
import { ownMcpUrl } from "../services/mcp-server.js";

/** One-line clip for payload/UI display; the full DTO keeps the raw text. */
function clipLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  opts: { env: { PORT: number } },
): Promise<void> {
  const ownUrl = ownMcpUrl(opts.env.PORT);

  /**
   * Day16 shape, day19 source: tools/list of OUR OWN MCP server (loopback).
   * The public DeepWiki client was removed 24.09 (Konstantin: the product
   * won't use it); the day16 response fields are preserved — top-level now
   * comes from the same loopback listing as the day17 `own` section.
   */
  app.get("/api/mcp/tools", async (_request, reply) => {
    try {
      const result = await listMcpTools(ownUrl);
      const own: OwnSection = {
        ok: true,
        url: ownUrl,
        serverInfo: result.serverInfo,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: clipLine(tool.description),
          inputSchema: tool.inputSchema,
        })),
      };
      return {
        server: result.server,
        transport: "streamable-http",
        serverInfo: result.serverInfo,
        toolCount: result.tools.length,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: clipLine(tool.description),
        })),
        own,
        meta: {
          tokensEstimate: estimateTokens(JSON.stringify(result.tools)),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(502);
      return { error: "MCP list tools failed", message };
    }
  });

/** Day17: own-section shape of GET /api/mcp/tools — ok:true with tools, or degraded. */
type OwnSection =
  | {
      ok: true;
      url: string;
      serverInfo: { name: string; version: string };
      tools: { name: string; description: string; inputSchema: unknown }[];
    }
  | { ok: false; url: string; error: string };

  /** Day17: raw tools/call against our own server — demo criterion + screencast. */
  app.post("/api/mcp/call", async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1),
        arguments: z.record(z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    const started = Date.now();
    try {
      // Day19 D-2: summarize nests an LLM call — 90 s (the 10 s client
      // default would kill it on the manual demo path too).
      const result = await callMcpTool(
        ownUrl,
        parsed.data.name,
        parsed.data.arguments ?? {},
        90_000,
      );
      return {
        name: parsed.data.name,
        content: result.content,
        isError: result.isError,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(502);
      return { error: "MCP tool call failed", message };
    }
  });
}
