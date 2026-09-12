import { z } from "zod";
import { LlmUsageSchema } from "./ask.js";

export const AgentPresetIdSchema = z.enum(["care", "strict", "open"]);
export type AgentPresetId = z.infer<typeof AgentPresetIdSchema>;

export const AgentContextLayersSchema = z.object({
  strategic: z.string().min(1),
  operational: z.string().min(1),
  task: z.string().min(1),
});
export type AgentContextLayers = z.infer<typeof AgentContextLayersSchema>;

export const AgentInputPolicySchema = z.object({
  trim: z.boolean().default(true),
  maxChars: z.number().int().positive().default(4_000),
  requireNonEmpty: z.boolean().default(true),
});
export type AgentInputPolicy = z.infer<typeof AgentInputPolicySchema>;

export const AgentOutputPolicySchema = z.object({
  trim: z.boolean().default(true),
  maxChars: z.number().int().positive().optional(),
  formatHint: z.enum(["soft", "short", "open"]).default("soft"),
});
export type AgentOutputPolicy = z.infer<typeof AgentOutputPolicySchema>;

export const AgentPresetSchema = z.object({
  id: AgentPresetIdSchema,
  label: z.string().min(1),
  role: z.string().min(1),
  instructions: z.string().min(1),
  layers: AgentContextLayersSchema,
  inputPolicy: AgentInputPolicySchema,
  outputPolicy: AgentOutputPolicySchema,
  defaultModel: z.string().optional(),
  defaultTemperature: z.number().min(0).max(2).default(0.7),
});
export type AgentPreset = z.infer<typeof AgentPresetSchema>;

export const AgentInstanceSchema = z.object({
  id: z.string().min(1),
  presetId: AgentPresetIdSchema,
  label: z.string().min(1),
  role: z.string().min(1),
  instructions: z.string().min(1),
  layers: AgentContextLayersSchema,
  inputPolicy: AgentInputPolicySchema,
  outputPolicy: AgentOutputPolicySchema,
  defaultModel: z.string().optional(),
  defaultTemperature: z.number().min(0).max(2),
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

export const InstanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  agents: z.array(AgentInstanceSchema),
  createdAt: z.string(),
});
export type Instance = z.infer<typeof InstanceSchema>;

/** Day08: `system` role carries history-compression summaries. */
export const AgentMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>;

/** Server-owned DTO; ₽ display computed on server. */
export const AgentMessageSchema = z.object({
  id: z.string().min(1),
  role: AgentMessageRoleSchema,
  content: z.string(),
  agentId: z.string().optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  usage: LlmUsageSchema.optional(),
  /** Display rubles: ProxyAPI rub or DeepSeek USD×FX. */
  cost_rub: z.number().nonnegative().optional(),
  /** Day08: tokens saved in the request by compressing this summary. */
  saved_tokens: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Day08: `tail` — sliding window (10), `full` — whole history (cap 100). */
export const AgentHistoryModeSchema = z.enum(["tail", "full"]);
export type AgentHistoryMode = z.infer<typeof AgentHistoryModeSchema>;

/** Request-size estimate split (heuristic; API usage stays the fact). */
export const TokenBreakdownSchema = z.object({
  system: z.number().int().nonnegative(),
  history: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  historyMessages: z.number().int().nonnegative(),
});
export type TokenBreakdownDto = z.infer<typeof TokenBreakdownSchema>;

/** Whole-thread tokens: estimate + billed usage facts. */
export const ThreadTokensSchema = z.object({
  count: z.number().int().nonnegative(),
  tokensEstimate: z.number().int().nonnegative(),
  tokensActualSum: z.number().int().nonnegative(),
  costRubSum: z.number().nonnegative(),
  /** Day08: total tokens saved by compressions in this thread. */
  savedTokensSum: z.number().int().nonnegative(),
});
export type ThreadTokensDto = z.infer<typeof ThreadTokensSchema>;

export const AgentRunTokensSchema = z.object({
  estimate: TokenBreakdownSchema,
  limit: z.number().int().positive(),
  historyMode: AgentHistoryModeSchema,
  historySent: z.number().int().nonnegative(),
  thread: ThreadTokensSchema.optional(),
});
export type AgentRunTokensDto = z.infer<typeof AgentRunTokensSchema>;

export const AgentRunRequestSchema = z.object({
  instanceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string(),
  overrides: z
    .object({
      model: z.string().min(1).optional(),
      temperature: z.number().min(0).max(2).optional(),
      historyMode: AgentHistoryModeSchema.optional(),
      /** Day09: auto-compress every M dialogue messages. Absent = server default (env); 0 = off. */
      compressEvery: z.number().int().nonnegative().max(100).optional(),
    })
    .optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

/** Day09: compression facts — shared by manual compress and autoCompression in run. */
export const CompressionInfoSchema = z.object({
  model: z.string(),
  latency_ms: z.number().int().nonnegative(),
  cost_rub: z.number().nonnegative(),
  /** before.tokensEstimate - after.tokensEstimate. */
  savedTokens: z.number().int().nonnegative(),
  summarizedMessages: z.number().int().nonnegative(),
  keptMessages: z.number().int().nonnegative(),
  usage: LlmUsageSchema,
});
export type CompressionInfo = z.infer<typeof CompressionInfoSchema>;

export const AgentRunResponseSchema = z.object({
  reply: z.string(),
  message: AgentMessageSchema,
  agent: z.object({
    id: z.string(),
    label: z.string(),
    presetId: AgentPresetIdSchema,
    role: z.string(),
    policies: z.object({
      input: AgentInputPolicySchema,
      output: AgentOutputPolicySchema,
    }),
    layers: AgentContextLayersSchema,
    model: z.string(),
    temperature: z.number(),
    overridesApplied: z
      .object({
        model: z.boolean(),
        temperature: z.boolean(),
      })
      .optional(),
  }),
  usage: LlmUsageSchema,
  latency_ms: z.number().int().nonnegative(),
  /** Day08: request size (estimate) + context limit + thread totals. */
  tokens: AgentRunTokensSchema.optional(),
  /** Day09: auto-compression performed before this run. Absent — none happened. */
  autoCompression: z
    .object({
      /** id of the system summary now in the thread (for the UI badge). */
      summaryId: z.string(),
      before: z.object({
        count: z.number().int().nonnegative(),
        tokensEstimate: z.number().int().nonnegative(),
      }),
      after: z.object({
        count: z.number().int().nonnegative(),
        tokensEstimate: z.number().int().nonnegative(),
      }),
      compression: CompressionInfoSchema,
    })
    .optional(),
  totals: z.unknown().optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

/** Day08: compress thread history into one system summary. */
export const CompressThreadRequestSchema = z.object({
  /** Dialogue messages kept verbatim (default 4). */
  keepLast: z.number().int().nonnegative().max(50).optional(),
  /** Summarizer model (default: server DEEPSEEK_MODEL). */
  model: z.string().min(1).optional(),
  /** Day08+ probe: idle A/B test question (default: server phrase). */
  question: z.string().min(1).max(2000).optional(),
});
export type CompressThreadRequest = z.infer<typeof CompressThreadRequestSchema>;

export const CompressThreadResponseSchema = z.object({
  summary: AgentMessageSchema,
  before: z.object({
    count: z.number().int().nonnegative(),
    tokensEstimate: z.number().int().nonnegative(),
  }),
  after: z.object({
    count: z.number().int().nonnegative(),
    tokensEstimate: z.number().int().nonnegative(),
  }),
  compression: CompressionInfoSchema,
  thread: z.array(AgentMessageSchema),
  totals: z.unknown().optional(),
});
export type CompressThreadResponse = z.infer<typeof CompressThreadResponseSchema>;

export const CreateInstanceRequestSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  seedPresetIds: z.array(AgentPresetIdSchema).max(8).optional(),
});
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequestSchema>;

export const AddAgentRequestSchema = z.object({
  presetId: AgentPresetIdSchema,
  label: z.string().min(1).max(64).optional(),
});
export type AddAgentRequest = z.infer<typeof AddAgentRequestSchema>;

export const RestoreAgentRequestSchema = z.object({
  agent: AgentInstanceSchema,
  messages: z.array(AgentMessageSchema).default([]),
  index: z.number().int().nonnegative().optional(),
});
export type RestoreAgentRequest = z.infer<typeof RestoreAgentRequestSchema>;

export const RestoreInstanceRequestSchema = z.object({
  instance: InstanceSchema,
  threads: z.record(z.string(), z.array(AgentMessageSchema)).default({}),
});
export type RestoreInstanceRequest = z.infer<typeof RestoreInstanceRequestSchema>;

export const SpawnRequestSchema = z.object({
  kind: z.enum(["agents", "instances"]),
  count: z.number().int().positive().max(100),
  presetId: AgentPresetIdSchema.optional(),
});
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;
