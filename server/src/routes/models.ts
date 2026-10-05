import type { FastifyInstance } from "fastify";
import type { DeepSeekService } from "../services/deepseek.js";

type ModelsRouteDeps = {
  deepSeekService: DeepSeekService;
};

/**
 * Day05: справочник моделей для комбобокса SPA. Раньше жил в ask.ts;
 * 04.10 (гейт 261004 §7) ask-роут снят, /api/models переехал сюда и
 * отдаёт только то, что читает SPA: { models: [{tier,label,model,via}] }
 * (demo-поля proxyapi / open_task_mode / open_preset_l удалены).
 */
export async function registerModelsRoutes(
  app: FastifyInstance,
  deps: ModelsRouteDeps,
): Promise<void> {
  app.get("/api/models", async () => {
    return {
      models: deps.deepSeekService.getDemoModels(),
    };
  });
}
