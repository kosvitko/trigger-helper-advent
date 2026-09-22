import type { FastifyInstance } from "fastify";
import { estimateTokens } from "../services/agent/token-estimate.js";
import { listMcpTools } from "../services/mcp-client.js";

/** One-line clip for payload/UI display; the full DTO keeps the raw text. */
function clipLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  opts: { env: { MCP_SERVER_URL: string } },
): Promise<void> {
  /** Day16: tools/list of the configured public MCP (read-only; no call_tool yet). */
  app.get("/api/mcp/tools", async (_request, reply) => {
    try {
      const result = await listMcpTools(opts.env.MCP_SERVER_URL);
      return {
        server: result.server,
        transport: "streamable-http",
        serverInfo: result.serverInfo,
        toolCount: result.tools.length,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: clipLine(tool.description),
        })),
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
}
