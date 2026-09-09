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

export const AgentMessageRoleSchema = z.enum(["user", "assistant"]);
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
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentRunRequestSchema = z.object({
  instanceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string(),
  overrides: z
    .object({
      model: z.string().min(1).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

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
  totals: z.unknown().optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

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
