import { AskRequestSchema } from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { DeepSeekService } from "../services/deepseek.js";
import type { PointsService } from "../services/points.js";
import { buildGroundedSystemPrompt } from "../services/prompt.js";

type AskRouteDeps = {
  pointsService: PointsService;
  deepSeekService: DeepSeekService;
};

export async function registerAskRoutes(
  app: FastifyInstance,
  deps: AskRouteDeps,
): Promise<void> {
  app.post("/api/ask", async (request, reply) => {
    const parsed = AskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const { pointId, question } = parsed.data;
    const point = await deps.pointsService.findById(pointId);
    if (!point) {
      return reply.status(400).send({
        error: "Point not found",
        pointId,
      });
    }

    try {
      const result = await deps.deepSeekService.chat([
        { role: "system", content: buildGroundedSystemPrompt(point) },
        { role: "user", content: question },
      ]);

      return { reply: result.reply, usage: result.usage };
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: "LLM request failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
