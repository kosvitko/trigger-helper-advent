import {
  ALLOWED_TRANSITIONS,
  CHAT_PRESETS,
  FACT_KEYS,
  STAGE_GOTO_LABELS,
  STAGE_LABELS,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import { AGENT_HISTORY_CAPS } from "../services/agent/llm-agent.js";

type AgentRouteDeps = {
  env: Env;
};

const CONTEXT_STRATEGIES = ["sliding", "facts", "branching"] as const;

/**
 * C+ CH-6 (cutover, D-10): stateful-поверхность снята целиком —
 * /api/instances*, messages/chat-task-state и записывающая ветка
 * /api/agent/run умерли (преемник — stateless POST /api/chat, routes/chat.ts;
 * SSE-транспорт живёт только там). Остался справочник GET /api/agents:
 * shared-таблица пресетов дословно (CH-1, 05-MINOR-3) + мета для UI.
 */
export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): Promise<void> {
  app.get("/api/agents", async () => ({
    presets: CHAT_PRESETS,
    caps: {
      maxInstances: deps.env.MAX_INSTANCES,
      maxAgentsPerInstance: deps.env.MAX_AGENTS_PER_INSTANCE,
    },
    /** Day09: Lab placeholder default (0 = off). */
    autoCompress: { defaultEvery: deps.env.AGENT_COMPRESS_EVERY },
    /** Day10 Lab meta. */
    contextStrategies: [...CONTEXT_STRATEGIES],
    factKeys: [...FACT_KEYS],
    memoryLayers: ["short", "working", "long"],
    historyCaps: AGENT_HISTORY_CAPS,
    /** Day13: canonical transition map — UI generates goto-buttons from it. */
    taskTransitions: ALLOWED_TRANSITIONS,
    /** Day15′ (260919): русские имена этапов/переходов — один источник для UI. */
    stageLabels: STAGE_LABELS,
    stageGotoLabels: STAGE_GOTO_LABELS,
  }));
}
