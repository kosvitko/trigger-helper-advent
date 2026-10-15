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
  app.get("/api/agents", async () => {
    const devOff =
      deps.env.DEV_HELP_ENABLED === "0" ||
      deps.env.DEV_HELP_ENABLED === "false";
    // Day33: support — то же правило «выключен env → скрыт из справочника».
    const supportOff =
      deps.env.SUPPORT_ENABLED === "0" ||
      deps.env.SUPPORT_ENABLED === "false";
    // Day34: files — то же правило.
    const filesOff =
      deps.env.FILES_ENABLED === "0" ||
      deps.env.FILES_ENABLED === "false";
    const hidden = new Set<string>();
    if (devOff) hidden.add("dev_help");
    if (supportOff) hidden.add("support");
    if (filesOff) hidden.add("files");
    return {
      presets: hidden.size
        ? CHAT_PRESETS.filter((p) => !hidden.has(p.id))
        : CHAT_PRESETS,
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
    };
  });
}
