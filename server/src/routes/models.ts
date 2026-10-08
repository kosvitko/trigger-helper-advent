import type { FastifyInstance } from "fastify";
import type { ModelsResponse } from "@trigger-helper/shared";
import type { Env } from "../config/env.js";
import type { DeepSeekService } from "../services/deepseek.js";
import { probeLocalLlm } from "../services/local-llm.js";

type ModelsRouteDeps = {
  deepSeekService: DeepSeekService;
  /** День 26: probe локального рантайма (OLLAMA_URL/LOCAL_LLM_ENABLED). */
  env: Env;
};

/**
 * Day05: справочник моделей для комбобокса SPA. Раньше жил в ask.ts;
 * 04.10 (гейт 261004 §7) ask-роут снят, /api/models переехал сюда и
 * отдаёт только то, что читает SPA: { models: [{tier,label,model,via}] }
 * (demo-поля proxyapi / open_task_mode / open_preset_l удалены).
 *
 * День 26 (D-26-4): ответ дополнен local-секцией из probe (кэш 30 с,
 * GET остаётся дешёвым) — это ЕДИНСТВЕННАЯ поверхность каталога локальных
 * моделей; отдельный /api/local-llm/models не заводится (дублировал бы
 * и дрейфовал). Форма ответа зафиксирована схемой shared ModelsResponseSchema.
 */
export async function registerModelsRoutes(
  app: FastifyInstance,
  deps: ModelsRouteDeps,
): Promise<void> {
  app.get("/api/models", async () => {
    const probe = await probeLocalLlm(deps.env);
    const response: ModelsResponse = {
      models: deps.deepSeekService.getDemoModels(),
      local: {
        runtime: "ollama",
        enabled: probe.enabled,
        entries: probe.entries,
      },
    };
    return response;
  });
}
