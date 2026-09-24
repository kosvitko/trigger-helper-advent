import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";

/** Costly / mutable POSTs — shared per-IP bucket (not GET health/usage/static). */
function isRateLimitedPath(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const path = url.split("?")[0] ?? "";
  if (path === "/api/ask") return true;
  if (path === "/api/compare") return true;
  if (path === "/api/agent/run") return true;
  if (path === "/api/spawn/instances") return true;
  if (path === "/api/instances") return true;
  if (path === "/api/mcp/call") return true;
  if (path === "/mcp") return true;
  if (/^\/api\/instances\/[^/]+\/agents$/.test(path)) return true;
  if (/^\/api\/instances\/[^/]+\/spawn$/.test(path)) return true;
  return false;
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function normalizeIp(ip: string): string {
  // Node may give ::ffff:127.0.0.1 for IPv4-mapped IPv6
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export async function registerIpRateLimit(
  app: FastifyInstance,
  env: Env,
): Promise<void> {
  if (env.RATE_LIMIT_MAX === 0) {
    app.log.info("IP rate limit disabled (RATE_LIMIT_MAX=0)");
    return;
  }

  const allowlist = parseAllowlist(env.RATE_LIMIT_ALLOWLIST);

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    nameSpace: "th-ip-llm",
    groupId: "th-costly-posts",
    keyGenerator: (request: FastifyRequest) => normalizeIp(request.ip),
    // allowList true → do not rate-limit this request
    allowList: (request: FastifyRequest) => {
      if (!isRateLimitedPath(request.method, request.url)) return true;
      const path = request.url.split("?")[0] ?? "";
      // Day17 (design F-B): our own server calls itself over loopback —
      // an agent run fires ~3 POST /mcp (initialize/initialized/tools/call)
      // and each #mcp-block render ~3 more. Without this exemption the
      // shared per-IP bucket would 429 the demo path mid-screencast.
      // Scoped to the MCP paths only; safe behind trustProxy: external
      // clients keep their real IPs.
      const isOwnMcpPath = path === "/mcp" || path === "/api/mcp/call";
      const ip = normalizeIp(request.ip);
      if (isOwnMcpPath && (ip === "127.0.0.1" || ip === "::1")) return true;
      return allowlist.has(ip);
    },
    errorResponseBuilder: (_request, context) => ({
      error: "Rate limit exceeded",
      message: `Слишком много запросов с этого IP. Лимит: ${context.max} / ${Math.round(context.ttl / 1000)} с. Подожди и попробуй снова.`,
      statusCode: 429,
    }),
  });

  app.log.info(
    {
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      allowlistSize: allowlist.size,
    },
    "IP rate limit enabled for LLM/mutation POSTs",
  );
}
