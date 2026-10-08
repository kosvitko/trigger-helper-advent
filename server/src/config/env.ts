import { z } from "zod";

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  /** OpenAI-compatible ProxyAPI (optional). Enables provider/model ids for day05. */
  PROXYAPI_API_KEY: z.string().min(1).optional(),
  PROXYAPI_BASE_URL: z
    .string()
    .url()
    .default("https://openai.api.proxyapi.ru/v1"),
  /**
   * Comma-separated weak,mid,strong model ids.
   * Example: gemini/gemini-2.0-flash,openai/gpt-4o-mini,anthropic/claude-sonnet-4-20250514
   */
  DEMO_MODELS: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Bind host (default 0.0.0.0). h3llo: HOST=127.0.0.1 in .env — Caddy is the only
   * public entry (host-ops M2 06.10: «наружу только proxy», reverse_proxy 127.0.0.1:3000). */
  HOST: z.string().optional(),
  DATA_DIR: z.string().optional(),
  /** Persistent usage totals JSON on VPS (default: <repo>/var/usage-totals.json). */
  USAGE_FILE: z.string().optional(),
  /** Day18: scheduler store (default: <repo>/var/scheduler.json). */
  SCHEDULER_FILE: z.string().optional(),
   /** Day18: min seconds between proactive LLM summaries. Default 900 → 86400
    *  (cust-fix 29.09): 15-min cadence burned ~₽40/day on the idle VPS —
    *  ensureMaterial() kept pulling random archive articles to summarize. */
   SCHEDULE_SUMMARY_MIN_SEC: z.coerce.number().int().positive().default(86_400),
  /** Day19: saved pipeline files dir (default: <repo>/var/pipelines). */
  PIPELINES_DIR: z.string().optional(),
  /**
   * Day21: embeddings model for the RAG index build
   * (default: Xenova/multilingual-e5-small). Search always uses the model
   * recorded in the index header — this env is the build default only.
   */
  RAG_EMBEDDINGS_MODEL: z.string().optional(),
  /** Day21: RAG index dir (default: <repo>/data/rag). */
  RAG_INDEX_DIR: z.string().optional(),
  /** Day21: HuggingFace weights cache (default: <repo>/var/hf-cache). */
  RAG_CACHE_DIR: z.string().optional(),
  /**
   * Day23: host capability switch for the cross-encoder reranker (design D-11
   * hardening, OOM measured 01.10). "0"/"false" → rerank/full arms answer 503
   * BEFORE any model load (mode-scoped degradation, base/rewrite keep working)
   * — the 568M q8 model does not fit next to the server on the 1.9 GB VPS.
   * Default: enabled (absent/any other value).
   */
  RAG_RERANK_ENABLED: z.string().optional(),
  /**
   * Day26: local LLM runtime — Ollama base URL (default:
   * http://127.0.0.1:11434; local dev and VPS systemd both bind 127.0.0.1).
   */
  OLLAMA_URL: z.string().optional(),
  /** Day26: whole-turn ceiling for a local generation, ms (default 120000 —
   *  below undici defaults, no extra transport config needed). */
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /**
   * Day26: host kill-switch for the local LLM branch (day-23 pattern,
   * RAG_RERANK_ENABLED). "0"/"false" → /api/models reports the local section
   * as disabled and local model ids fail 503 BEFORE any runtime call.
   * Default: enabled (absent/any other value).
   */
  LOCAL_LLM_ENABLED: z.string().optional(),
  /**
   * Day20: external MCP servers, comma-separated `name=url` (name: [a-z0-9]+).
   * Own server is always registered from PORT; absent value = own-only (day19).
   * Per-server LLM injection filter: MCP_INJECT_<NAME> (comma-list of native
   * tool names) — read directly from process.env by mcp-registry.ts; a server
   * without the key injects NOTHING (fail-closed, design D-3).
   */
  MCP_SERVERS: z.string().optional(),
  /**
   * Daily cap for expensive models only (0 = off). Moscow calendar day.
   * DeepSeek / flash-lite / gpt-4o-mini / haiku — без лимита.
   */
  FREE_DAILY_ASKS: z.coerce.number().int().nonnegative().default(20),
  /** Day06 demo caps (in-memory instances / agents). */
  MAX_INSTANCES: z.coerce.number().int().positive().default(8),
  MAX_AGENTS_PER_INSTANCE: z.coerce.number().int().positive().default(16),
  /**
   * Day08 demo: force one small context window (tokens) for every model to
   * show the overflow path without a 100-message thread. 0 = per-model limit.
   */
  DEMO_CONTEXT_LIMIT: z.coerce.number().int().nonnegative().default(0),
  /**
   * Day09: auto-compress the thread every M dialogue messages (beyond the
   * keepLast tail) before answering. 0 = off. Per-request Lab override wins.
   */
  AGENT_COMPRESS_EVERY: z.coerce.number().int().nonnegative().default(10),
  /**
   * Per-IP rate limit for costly POSTs (/api/chat, /mcp — stateless после
   * cutover CH-6). 0 = off. Needs trustProxy behind proxy so req.ip = client.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(30),
  /** Window ms for RATE_LIMIT_MAX (default 60s). */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Comma-separated IPs exempt from IP rate limit (dev / office).
   * Does NOT bypass cost-aware ₽ budget or FREE_DAILY_ASKS.
   * Example: 127.0.0.1,::1,95.x.y.z
   */
  RATE_LIMIT_ALLOWLIST: z.string().optional(),
  /** Daily billing ₽ budget all models (0 = cost-aware off). Package B default. */
  DAILY_BUDGET_RUB: z.coerce.number().nonnegative().default(300),
  /** Extra daily ₽ cap for expensive models only (0 = off). */
  DAILY_BUDGET_EXPENSIVE_RUB: z.coerce.number().nonnegative().default(150),
  BUDGET_DELAY_ALPHA: z.coerce.number().positive().default(2.5),
  BUDGET_DELAY_BETA: z.coerce.number().positive().default(2),
  BUDGET_DELAY_FILL_MS: z.coerce.number().nonnegative().default(20_000),
  BUDGET_DELAY_PACE_MS: z.coerce.number().nonnegative().default(60_000),
  BUDGET_DELAY_MAX_MS: z.coerce.number().nonnegative().default(180_000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  return parsed.data;
}
