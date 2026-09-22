import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Day16: minimal MCP client over Streamable HTTP — connect + tools/list only.
 * Tool descriptions are untrusted third-party text: they stay data for the API/UI
 * and must not be injected into agent prompts until day 17-18 orchestration lands.
 */

export type McpToolInfo = {
  name: string;
  description: string;
  /** Raw JSON Schema from tools/list — kept for days 17+ (call_tool / orchestration). */
  inputSchema: unknown;
};

export type McpToolsResult = {
  server: string;
  serverInfo: { name: string; version: string };
  tools: McpToolInfo[];
};

const CLIENT_INFO = { name: "trigger-helper", version: "0.1.0" } as const;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Day16 contract: connect and listTools are explicit steps; the transport stays
 * behind this module so days 17-20 can reuse the connection for call_tool.
 * Lifecycle is per-call (connect → work → close) — no session state to persist.
 */
export async function withMcpConnection<T>(
  serverUrl: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    return await work(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listMcpTools(serverUrl: string): Promise<McpToolsResult> {
  return withMcpConnection(serverUrl, async (client) => {
    const { tools } = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS });
    const serverVersion = client.getServerVersion();
    return {
      server: serverUrl,
      serverInfo: {
        name: serverVersion?.name ?? "unknown",
        version: serverVersion?.version ?? "unknown",
      },
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })),
    };
  });
}
