import type { FastifyInstance } from "fastify";
import { getLocalLlmGate } from "../services/local-llm-gate.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "trigger-helper",
    // День 30: снимок семафора локальной ветки (curl / второй клиент).
    localQueue: getLocalLlmGate().snapshot(),
  }));
}
