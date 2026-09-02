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

export const AskControlsSchema = z.enum(["none", "strict"]);

export const ReasoningModeSchema = z.enum([
  "direct",
  "step_by_step",
  "meta",
  "experts",
]);

export const AskRequestSchema = z.object({
  pointId: z.string().min(1),
  question: z.string().min(1),
  controls: AskControlsSchema.optional(),
  reasoningMode: ReasoningModeSchema.optional(),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  reply: z.string(),
  usage: LlmUsageSchema,
});

export type AskResponse = z.infer<typeof AskResponseSchema>;
