import { z } from "zod";

export const LlmUsageSchema = z.object({
  model: z.string(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative(),
  prompt_cache_miss_tokens: z.number().int().nonnegative(),
  /** Rough estimate from DeepSeek list prices (USD per 1M tokens). */
  estimated_cost_usd: z.number().nonnegative(),
});

export type LlmUsage = z.infer<typeof LlmUsageSchema>;

/** Persistent totals on the server (VPS file), not browser storage. */
export const UsageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cache_hit_tokens: z.number().int().nonnegative(),
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

export const AskRequestSchema = z.object({
  pointId: z.string().min(1),
  question: z.string().min(1),
  format: AskFormatSchema.optional().default("free"),
  controls: AskControlsSchema.optional(),
  reasoningMode: ReasoningModeSchema.optional().default("direct"),
  temperature: AskTemperatureSchema.optional().default(0),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  reply: z.string(),
  usage: LlmUsageSchema,
  format: AskFormatSchema,
  reasoningMode: ReasoningModeSchema.optional(),
  temperature: AskTemperatureSchema.optional(),
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
  totals: UsageTotalsSchema.optional(),
});

export type CompareResponse = z.infer<typeof CompareResponseSchema>;
