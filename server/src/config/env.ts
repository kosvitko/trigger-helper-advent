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
  DATA_DIR: z.string().optional(),
  /** Persistent usage totals JSON on VPS (default: <repo>/var/usage-totals.json). */
  USAGE_FILE: z.string().optional(),
  /** Day07: agent context file (default: <repo>/var/agent-state.json). */
  AGENT_STATE_FILE: z.string().optional(),
  /**
   * Daily cap for expensive models only (0 = off). Moscow calendar day.
   * DeepSeek / flash-lite / gpt-4o-mini / haiku — без лимита.
   */
  FREE_DAILY_ASKS: z.coerce.number().int().nonnegative().default(20),
  /** Day06 demo caps (in-memory instances / agents). */
  MAX_INSTANCES: z.coerce.number().int().positive().default(8),
  MAX_AGENTS_PER_INSTANCE: z.coerce.number().int().positive().default(16),
  /**
   * Per-IP rate limit for costly POSTs (ask / compare / agent / spawn / create).
   * 0 = off. Needs trustProxy behind nginx so req.ip = client, not 127.0.0.1.
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
