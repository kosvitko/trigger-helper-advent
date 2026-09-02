import { z } from "zod";

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().optional(),
  /** Persistent usage totals JSON on VPS (default: <repo>/var/usage-totals.json). */
  USAGE_FILE: z.string().optional(),
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
