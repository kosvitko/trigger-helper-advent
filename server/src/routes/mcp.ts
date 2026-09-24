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
  opts: { env: { MCP_SERVER_URL: string; PORT: number } },
): Promise<void> {
  const ownUrl = ownMcpUrl(opts.env.PORT);

  /** Day16: tools/list of the configured public MCP (read-only; no call_tool). */
  app.get("/api/mcp/tools", async (_request, reply) => {
    try {
      const result = await listMcpTools(opts.env.MCP_SERVER_URL);
      // Day17: own atlas server next to the public one. The day16 shape is
      // untouched (deepwiki part must keep working); own failure degrades
      // into own.ok=false instead of failing the whole endpoint.
      let own: OwnSection;
      try {
        own = await ownSection(ownUrl);
      } catch (error) {
        own = {
          ok: false,
          url: ownUrl,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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

/** Day17: own-section of GET /api/mcp/tools — ok:true with tools, or degraded. */
type OwnSection =
  | {
      ok: true;
      url: string;
      serverInfo: { name: string; version: string };
      tools: { name: string; description: string; inputSchema: unknown }[];
    }
  | { ok: false; url: string; error: string };

async function ownSection(url: string): Promise<Extract<OwnSection, { ok: true }>> {
  const result = await listMcpTools(url);
  return {
    ok: true,
    url,
    serverInfo: result.serverInfo,
    tools: result.tools.map((tool) => ({
      name: tool.name,
      description: clipLine(tool.description),
      inputSchema: tool.inputSchema,
    })),
  };
}

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
      const result = await callMcpTool(
        ownUrl,
        parsed.data.name,
        parsed.data.arguments ?? {},
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
