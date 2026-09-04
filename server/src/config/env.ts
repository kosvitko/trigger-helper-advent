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
  /**
   * Daily cap for expensive models only (0 = off). Moscow calendar day.
   * DeepSeek / flash-lite / gpt-4o-mini / haiku — без лимита.
   */
  FREE_DAILY_ASKS: z.coerce.number().int().nonnegative().default(20),
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
