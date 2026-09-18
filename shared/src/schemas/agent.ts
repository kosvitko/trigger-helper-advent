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

/** Day10: context assembly strategy (primary Lab switch). */
export const AgentContextStrategySchema = z.enum([
  "sliding",
  "facts",
  "branching",
]);
export type AgentContextStrategy = z.infer<typeof AgentContextStrategySchema>;

/** Day10 sticky-facts allowlist only (M-1). */
export const FACT_KEYS = [
  "цель",
  "ограничения",
  "предпочтения",
  "решения",
  "договорённости",
] as const;
export const FactKeySchema = z.enum(FACT_KEYS);
export type FactKey = z.infer<typeof FactKeySchema>;
export const FactsMapSchema = z
  .record(FactKeySchema, z.string().min(1))
  .default({});
export type FactsMap = z.infer<typeof FactsMapSchema>;

/** Day11: memory layer placement (short / working / long). */
export const MemoryLayerSchema = z.enum(["short", "working", "long"]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const FactSourceSchema = z.enum(["classify", "manual"]);
export type FactSource = z.infer<typeof FactSourceSchema>;

export const FactRowSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  key: z.string().min(1).optional(),
  layer: MemoryLayerSchema,
  suggestedLayer: MemoryLayerSchema,
  source: FactSourceSchema,
  overridden: z.boolean().optional(),
  updatedAt: z.string().min(1),
});
export type FactRow = z.infer<typeof FactRowSchema>;

/** Self-expiring suppressor: a deleted fact cannot be re-added while its source
 *  may still sit in the classify sliding window (untilSeq = thread length + window). */
export const FactTombstoneSchema = z.object({
  norm: z.string().min(1),
  untilSeq: z.number().int().nonnegative(),
});
export type FactTombstone = z.infer<typeof FactTombstoneSchema>;

/** Day11 memory slice — facts only (S0′: no speculative FSM stubs). */
export const AgentMemorySliceSchema = z.object({
  facts: z.array(FactRowSchema).default([]),
  deleted: z.array(FactTombstoneSchema).default([]),
});
export type AgentMemorySlice = z.infer<typeof AgentMemorySliceSchema>;

export const MemoryClassifyItemSchema = z.object({
  text: z.string().min(1),
  key: z.string().min(1).optional(),
  suggestedLayer: MemoryLayerSchema,
});
export type MemoryClassifyItem = z.infer<typeof MemoryClassifyItemSchema>;
export const MemoryClassifyListSchema = z.array(MemoryClassifyItemSchema);

export const MemoryFactPatchSchema = z.object({
  layer: MemoryLayerSchema,
});
export type MemoryFactPatch = z.infer<typeof MemoryFactPatchSchema>;

export const MemoryFactCreateSchema = z.object({
  text: z.string().min(1).max(2_000),
  layer: MemoryLayerSchema.optional(),
});
export type MemoryFactCreate = z.infer<typeof MemoryFactCreateSchema>;

/** Day12: user personalization profile (instance-level; active one injects into every request). */
export const UserProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  style: z.string().max(200).optional(),
  format: z.string().max(200).optional(),
  constraints: z.array(z.string().min(1).max(80)).max(5).default([]),
  updatedAt: z.string().min(1),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserProfileCreateSchema = z.object({
  label: z.string().min(1).max(120),
  style: z.string().max(200).optional(),
  format: z.string().max(200).optional(),
  constraints: z.array(z.string().min(1).max(80)).max(5).default([]),
});
export type UserProfileCreate = z.infer<typeof UserProfileCreateSchema>;

export const UserProfilePatchSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  style: z.string().max(200).optional(),
  format: z.string().max(200).optional(),
  constraints: z.array(z.string().min(1).max(80)).max(5).optional(),
});
export type UserProfilePatch = z.infer<typeof UserProfilePatchSchema>;

export const ProfileActivateSchema = z.object({
  /** null = явная деактивация: инжект-блока нет, day11-поведение. */
  profileId: z.string().min(1).nullable(),
});
export type ProfileActivate = z.infer<typeof ProfileActivateSchema>;

/** Day12 instance-level profile state: list + manual router (activeProfileId). */
export const ProfileStateSchema = z.object({
  profiles: z.array(UserProfileSchema).default([]),
  activeProfileId: z.string().min(1).nullable().default(null),
});
export type ProfileState = z.infer<typeof ProfileStateSchema>;

/** Day13: task FSM stages — canonical 4 (лекция недели 3: не уменьшать; done терминальная). */
export const TaskStageSchema = z.enum(["planning", "execution", "validation", "done"]);
export type TaskStage = z.infer<typeof TaskStageSchema>;

/** Day13: formal task state on an agent (one active task; pause = операция, не стадия). */
export const TaskStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  stage: TaskStageSchema,
  /** 1-based index into plan; clamp min(step, plan.length) on plan PATCH. */
  step: z.number().int().min(1),
  plan: z.array(z.string().min(1).max(120)).min(1).max(5),
  expectedAction: z.string().max(200),
  paused: z.boolean(),
  /** Инвариант: pausedFrom != null ⟺ paused; в done пауза запрещена. */
  pausedFrom: TaskStageSchema.nullable(),
  /** Резюме сделанного (1–2 строки) — re-inject при resume без пересказа. */
  lastStageNote: z.string().max(200),
  updatedAt: z.string().min(1),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(120),
  plan: z.array(z.string().min(1).max(120)).min(1).max(5),
  /** Absent → plan[0]. */
  expectedAction: z.string().max(200).optional(),
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

/** PATCH правит текст задачи; stage/step/paused меняются только через transition. */
export const TaskPatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  plan: z.array(z.string().min(1).max(120)).min(1).max(5).optional(),
  expectedAction: z.string().max(200).optional(),
  lastStageNote: z.string().max(200).optional(),
});
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

export const TaskTransitionSchema = z
  .object({
    action: z.enum(["goto", "pause", "resume", "next_step"]),
    /** Только при action="goto" (иначе 400 — refine ниже). */
    to: TaskStageSchema.optional(),
    /** Day14 D-6: инвариант согласия — goto→done требует явного подтверждения
     *  пользователя. Вне goto→done молча игнорируется (без refine). */
    consent: z.boolean().optional(),
  })
  .refine((v) => v.action === "goto" || v.to === undefined, {
    message: "to допустим только при action=goto",
  });
export type TaskTransition = z.infer<typeof TaskTransitionSchema>;

/** Day14 D-2: инварианты — правил владельца, не факт памяти (не
 *  MemoryStateStore: tombstones + classify легализуют запреты из диалога).
 *  Уровень — агент (зеркало taskStates); scope рядов: agent = всегда,
 *  task = при активной задаче (stage != done). */
export const InvariantScopeSchema = z.enum(["agent", "task"]);
export type InvariantScope = z.infer<typeof InvariantScopeSchema>;

export const InvariantEnforcementSchema = z.enum(["hard", "soft"]);
export type InvariantEnforcement = z.infer<typeof InvariantEnforcementSchema>;

const invariantPatternSchema = z.string().trim().min(1).max(120);

export const InvariantRowSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(200),
    scope: InvariantScopeSchema,
    enforcement: InvariantEnforcementSchema,
    /** RegExp-источник против входа пользователя; только hard (refine ниже).
     *  Пустой/пробельный отсечён (05 Fix-1: RegExp("") матчит всё). */
    pattern: invariantPatternSchema.optional(),
    /** false — только явным действием владельца (UI/CRUD); агентом и через
     *  диалог инвариант не отключаем (D-2). */
    active: z.boolean().default(true),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .refine((row) => !(row.pattern !== undefined && row.enforcement !== "hard"), {
    message: "pattern допустим только при enforcement=hard",
  });
export type InvariantRow = z.infer<typeof InvariantRowSchema>;

export const InvariantCreateSchema = z
  .object({
    text: z.string().min(1).max(200),
    scope: InvariantScopeSchema,
    enforcement: InvariantEnforcementSchema.default("soft"),
    pattern: invariantPatternSchema.optional(),
  })
  .refine((v) => !(v.pattern !== undefined && v.enforcement !== "hard"), {
    message: "pattern допустим только при enforcement=hard",
  });
export type InvariantCreate = z.infer<typeof InvariantCreateSchema>;

/** PATCH: absent = keep; строка pattern = заменить, null = убрать.
 *  Refine «pattern только при hard» — серверный (нужен текущий ряд). */
export const InvariantPatchSchema = z.object({
  text: z.string().min(1).max(200).optional(),
  scope: InvariantScopeSchema.optional(),
  enforcement: InvariantEnforcementSchema.optional(),
  pattern: invariantPatternSchema.nullable().optional(),
  active: z.boolean().optional(),
});
export type InvariantPatch = z.infer<typeof InvariantPatchSchema>;

/** Agent-level invariant list (зеркало ProfileState; per-key safeParse). */
export const InvariantStateSchema = z.object({
  invariants: z.array(InvariantRowSchema).max(8).default([]),
});
export type InvariantState = z.infer<typeof InvariantStateSchema>;

/** Request-size estimate split (heuristic; API usage stays the fact). */
export const TokenBreakdownSchema = z.object({
  system: z.number().int().nonnegative(),
  history: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  historyMessages: z.number().int().nonnegative(),
  /** Day10: extract call tokens when known before estimate assembly. */
  extract: z.number().int().nonnegative().optional(),
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
      /** Day10 primary: context assembly strategy. Absent = day09 (historyMode only). */
      contextStrategy: AgentContextStrategySchema.optional(),
    })
    .optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

/** Day10: what actually went into the LLM (frame evidence). */
export const AgentRunContextSchema = z.object({
  strategy: AgentContextStrategySchema.optional(),
  /** History messages sent to the LLM (without the agent system prompt). */
  historyMessages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  ),
  facts: FactsMapSchema.optional(),
  extract: z
    .object({
      ok: z.boolean(),
      usage: LlmUsageSchema.optional(),
      latency_ms: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Day12: personalization frame — active profile + inject evidence (null = no profile). */
  profile: z
    .object({
      id: z.string().min(1),
      label: z.string().min(1),
      /** Текст system-блока, ушедшего в запрос (null — все поля пустые). */
      inject: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** Day13: task FSM frame — formal state + inject evidence (null = no task; в done inject=null). */
  task: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      stage: TaskStageSchema,
      step: z.number().int().min(1),
      total: z.number().int().min(1),
      paused: z.boolean(),
      /** Текст system-блока задачи, ушедшего в запрос (null — done). */
      inject: z.string().nullable(),
      /** Fail-open проверка стадии; в done валидатор не зовётся — поля нет.
       *  level: ok — стадия подтверждена, warn — не подтверждена (fail-open),
       *  critical — нарушение инварианта (день 14). */
      check: z
        .object({
          ok: z.boolean(),
          level: z.enum(["ok", "warn", "critical"]).optional(),
          note: z.string().max(200),
        })
        .optional(),
    })
    .nullable()
    .optional(),
  /** Day14: invariants frame — owner rules + inject evidence (null = пусто). */
  invariants: z
    .object({
      checked: z
        .array(
          z.object({
            n: z.number().int().min(1),
            id: z.string().min(1),
            scope: InvariantScopeSchema,
            enforcement: InvariantEnforcementSchema,
            text: z.string().max(200),
          }),
        )
        .min(1),
      inject: z.string(),
      check: z
        .object({
          ok: z.boolean(),
          level: z.enum(["ok", "warn", "critical"]).optional(),
          note: z.string().max(200),
        })
        .optional(),
    })
    .nullable()
    .optional(),
  /** Day11: layered memory frame (registry + inject evidence). */
  memory: z
    .object({
      facts: z.array(FactRowSchema),
      inject: z.object({
        long: z.array(z.string()),
        working: z.array(z.string()),
        short: z.array(z.string()),
      }),
      classify: z
        .object({
          ok: z.boolean(),
          usage: LlmUsageSchema.optional(),
          latency_ms: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type AgentRunContext = z.infer<typeof AgentRunContextSchema>;

/** Day10 branching meta (GET /branch and messages hydrate). */
export const BranchStateSchema = z.object({
  forked: z.boolean(),
  activeBranchId: z.enum(["a", "b"]).nullable(),
  branches: z.array(z.enum(["a", "b"])),
  checkpointCount: z.number().int().nonnegative().optional(),
});
export type BranchState = z.infer<typeof BranchStateSchema>;

export const BranchCheckpointRequestSchema = z.object({
  messageId: z.string().min(1).optional(),
});
export type BranchCheckpointRequest = z.infer<
  typeof BranchCheckpointRequestSchema
>;

export const BranchForkResponseSchema = z.object({
  branches: z.array(z.enum(["a", "b"])),
  activeBranchId: z.enum(["a", "b"]),
  prefixCount: z.number().int().nonnegative(),
});
export type BranchForkResponse = z.infer<typeof BranchForkResponseSchema>;

export const BranchSwitchRequestSchema = z.object({
  branchId: z.enum(["a", "b"]),
});
export type BranchSwitchRequest = z.infer<typeof BranchSwitchRequestSchema>;

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
  /** Day10: strategy frame — history sent + optional facts/extract. */
  context: AgentRunContextSchema.optional(),
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
