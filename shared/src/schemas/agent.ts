import { z } from "zod";
import { LlmUsageSchema } from "./ask.js";

/** Day25 + C+: живые пресеты stateless-чата (strict/open умерли со старым UI
 *  и stateful-инстансами — cutover CH-6, старые записи не поддерживаем). */
export const AgentPresetIdSchema = z.enum(["care", "rag_chat"]);
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

/** Day10: context assembly strategy (llm-agent internal; stateless-ход не
 *  выставляет — стратегии умерли вместе с серверными тредами, D-4). */
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

/** Day12: user personalization profile (global; active one injects into every request). */
export const UserProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  style: z.string().max(200).optional(),
  format: z.string().max(200).optional(),
  constraints: z.array(z.string().min(1).max(80)).max(5).default([]),
  updatedAt: z.string().min(1),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

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

/** Day25: лёгкая память задачи мини-чата (Q-c) — ключ threadAgentId.
 *  goal — одна строка-цель диалога; clarified — короткие уточнения;
 *  constraints_terms — ограничения и термины, зафиксированные пользователем. */
export const ChatTaskStateSchema = z.object({
  goal: z.string().max(300).default(""),
  clarified: z.array(z.string().min(1).max(160)).max(8).default([]),
  constraints_terms: z.array(z.string().min(1).max(160)).max(8).default([]),
});
export type ChatTaskState = z.infer<typeof ChatTaskStateSchema>;

/** PATCH панели «Память задачи»: absent = keep (02b-F-1, ручное редактирование). */
export const ChatTaskStatePatchSchema = z.object({
  goal: z.string().max(300).optional(),
  clarified: z.array(z.string().min(1).max(160)).max(8).optional(),
  constraints_terms: z.array(z.string().min(1).max(160)).max(8).optional(),
});
export type ChatTaskStatePatch = z.infer<typeof ChatTaskStatePatchSchema>;

/** C+ (D-10): кадр-evidence stateless-хода — что реально ушло в LLM. */
export const AgentRunContextSchema = z.object({
  /** History messages sent to the LLM (without the agent system prompt). */
  historyMessages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string(),
    }),
  ),
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
       *  critical — красное нарушение: инвариант (день 14) или стадия при
       *  skip-запросе (день 15). retried — был retry-once (день 15). */
      check: z
        .object({
          ok: z.boolean(),
          level: z.enum(["ok", "warn", "critical"]).optional(),
          note: z.string().max(200),
          retried: z.boolean().optional(),
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
          retried: z.boolean().optional(),
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
  /** Day17: MCP tool calls inside this run — present only in tools-runs;
   *  calls — always an array (failure = row with ok:false). */
  tool: z
    .object({
      calls: z.array(
        z.object({
          name: z.string().min(1),
          arguments: z.unknown().optional(),
          ok: z.boolean(),
          latencyMs: z.number().int().nonnegative(),
          resultClip: z.string(),
          /** Day25 (02b-F-3): аддитивный структурный payload тулзы
           *  (rag_ask: answer/quotes/sources/dontKnow/topCosine/usage) —
           *  UI-карточка рендерится из него, resultClip остаётся обязательным. */
          payload: z.unknown().optional(),
        }),
      ),
    })
    .optional(),
  /** Day25: эхо памяти задачи после экстракта хода (только rag-ходы). */
  chatTaskState: ChatTaskStateSchema.optional(),
});
export type AgentRunContext = z.infer<typeof AgentRunContextSchema>;
