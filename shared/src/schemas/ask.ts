import { z } from "zod";

export const LlmUsageSchema = z.object({
  model: z.string(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative(),
  prompt_cache_miss_tokens: z.number().int().nonnegative(),
  /** DeepSeek list prices (USD). ProxyAPI rows stay 0. */
  estimated_cost_usd: z.number().nonnegative(),
  /** ProxyAPI list prices (RUB). DeepSeek rows stay 0 — UI may show USD×103 separately. */
  estimated_cost_rub: z.number().nonnegative().default(0),
});

export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const UsageModelBucketSchema = z.object({
  requests: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  cost_rub: z.number().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
  cache_hit_tokens: z.number().int().nonnegative(),
});

export type UsageModelBucket = z.infer<typeof UsageModelBucketSchema>;

/** Persistent totals on the server (VPS file), not browser storage. */
export const UsageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  /** ProxyAPI billing currency totals. */
  cost_rub: z.number().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
  cache_hit_tokens: z.number().int().nonnegative(),
  by_model: z.record(z.string(), UsageModelBucketSchema).default({}),
  /** YYYY-MM-DD (Europe/Moscow) for expensive daily counter. */
  expensive_day: z.string().optional(),
  /** Asks to expensive models today (resets when expensive_day changes). */
  expensive_asks_today: z.number().int().nonnegative().default(0),
  updated_at: z.string(),
});

export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const AskFormatSchema = z.enum(["free", "json"]);

export type AskFormat = z.infer<typeof AskFormatSchema>;

/** @deprecated day02 uses AskFormatSchema; kept for older callers */
export const AskControlsSchema = z.enum(["none", "strict"]);

/** Advent day03 — four organizer modes; experts split into fixed + auto. */
export const ReasoningModeSchema = z.enum([
  "direct",
  "step_by_step",
  "meta",
  "experts_fixed",
  "experts_auto",
]);

export type ReasoningMode = z.infer<typeof ReasoningModeSchema>;

/** grounded = point card; open = no card (lab / day05 preset L). */
export const AskScopeSchema = z.enum(["grounded", "open"]);

export type AskScope = z.infer<typeof AskScopeSchema>;

/**
 * DeepSeek chat temperature range [0, 2]. Product default: 0.
 * Demo sweep markers: ASK_TEMPERATURES (assignment 0 / 0.7 / 1.2).
 * 1.9 removed from presets — above ~1.2 DeepSeek often loses coherent RU (author experiments).
 */
export const AskTemperatureSchema = z.coerce
  .number()
  .min(0)
  .max(2)
  .transform((n) => Math.round(n * 10) / 10);

export type AskTemperature = z.infer<typeof AskTemperatureSchema>;

/** Demo sweep / UI markers (organizer assignment). */
export const ASK_TEMPERATURES = [0, 0.7, 1.2] as const satisfies readonly AskTemperature[];

/** Day05 open L — сейчас private TG; публичный демо-текст: docs/advent/task-L-demo-public.md */
/**
 * `private` — open-задача редактируема (lab); счётчик дорогих не растёт.
 * `public` — Advent L: readonly UI + сервер подставляет OPEN_PRESET_L_QUESTION.
 * Личная TG-задача: docs/private/task-compressed-feed-telegram.md
 */
export const OPEN_TASK_MODE = "public" as "private" | "public";

/** Day05 open L — публичный демо-текст (docs/advent/task-L-demo-public.md). */
export const OPEN_PRESET_L_QUESTION =
  "Пользователь впервые открыл приложение самопомощи и написал: «болит шея». Спроектируй один первый экран: что спросить / что показать (1–2 точки или зоны) / нужна ли графика или анимация / 3 шага самопомощи / дисклеймер.\nСтруктура: цель → сценарий 3–5 шагов → содержимое экрана → 2 риска → MVP. Без кода. Коротко и по делу.";

/**
 * Default ×3 tiers. Prefer ProxyAPI ids (`provider/model`) when PROXYAPI_API_KEY set.
 * Override via env DEMO_MODELS=weakId,midId,strongId.
 */
export const ASK_DEMO_MODEL_TIERS = [
  {
    tier: "weak",
    label: "быстрая",
    proxyModel: "gemini/gemini-2.5-flash-lite",
    deepseekModel: "deepseek-chat",
  },
  {
    tier: "mid",
    label: "средняя",
    proxyModel: "gemini/gemini-2.5-flash",
    deepseekModel: "deepseek-chat",
  },
  {
    tier: "strong",
    label: "сильная",
    proxyModel: "anthropic/claude-sonnet-4-5",
    deepseekModel: "deepseek-reasoner",
  },
] as const;

export type AskDemoModelTier = (typeof ASK_DEMO_MODEL_TIERS)[number]["tier"];

export const AskRequestSchema = z
  .object({
    scope: AskScopeSchema.optional().default("grounded"),
    pointId: z.string().min(1).optional(),
    question: z.string().min(1),
    format: AskFormatSchema.optional().default("free"),
    controls: AskControlsSchema.optional(),
    reasoningMode: ReasoningModeSchema.optional().default("direct"),
    temperature: AskTemperatureSchema.optional().default(0),
    /** Override chat model (DeepSeek id or ProxyAPI `provider/model`). */
    model: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === "grounded" && !data.pointId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pointId is required when scope=grounded",
        path: ["pointId"],
      });
    }
    if (data.scope === "open" && data.format === "json") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "format=json is only supported with scope=grounded",
        path: ["format"],
      });
    }
  });

export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  reply: z.string(),
  usage: LlmUsageSchema,
  format: AskFormatSchema,
  scope: AskScopeSchema.optional(),
  reasoningMode: ReasoningModeSchema.optional(),
  temperature: AskTemperatureSchema.optional(),
  model: z.string().optional(),
  /** Server-side LLM round-trip (ms) — for demo/report timing. */
  latency_ms: z.number().int().nonnegative(),
  /** Present when reasoningMode=meta: prompt written by the model before answering. */
  metaPrompt: z.string().optional(),
  /** Server-wide totals after this request (VPS persistence). */
  totals: UsageTotalsSchema.optional(),
});

export type AskResponse = z.infer<typeof AskResponseSchema>;

export const CompareScenarioSchema = z.enum(["N", "P"]);

export type CompareScenario = z.infer<typeof CompareScenarioSchema>;

export const CompareCandidateSchema = z.object({
  mode: ReasoningModeSchema,
  reply: z.string().min(1),
});

export const CompareRequestSchema = z.object({
  scenario: CompareScenarioSchema,
  question: z.string().min(1),
  candidates: z.array(CompareCandidateSchema).min(2),
});

export type CompareRequest = z.infer<typeof CompareRequestSchema>;

export const CriterionScoreSchema = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
});

export const CompareModeScoreSchema = z.object({
  mode: ReasoningModeSchema,
  criteria: z.array(CriterionScoreSchema),
  passed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

export const CompareResponseSchema = z.object({
  scores: z.array(CompareModeScoreSchema),
  winner: ReasoningModeSchema.nullable(),
  rationale: z.string(),
  usage: LlmUsageSchema,
  /** Judge LLM round-trip (ms). */
  latency_ms: z.number().int().nonnegative().optional(),
  totals: UsageTotalsSchema.optional(),
});

export type CompareResponse = z.infer<typeof CompareResponseSchema>;
