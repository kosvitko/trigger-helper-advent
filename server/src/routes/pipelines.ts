import type { FastifyInstance } from "fastify";
import type { PipelinesService } from "../services/pipelines.js";

/**
 * Day19: read-only view over var/pipelines/ — list (name/bytes/mtime,
 * newest first) and ?name= content with the same sanitization as the
 * saveToFile tool (design D-7). The screencast's raw-JSON final frame.
 */
export async function registerPipelinesRoutes(
  app: FastifyInstance,
  opts: { pipelines: PipelinesService },
): Promise<void> {
  app.get("/api/pipelines", async (request, reply) => {
    const query = request.query as { name?: string };
    if (query.name) {
      const file = await opts.pipelines.readFile(query.name);
      if (!file) {
        return reply.status(404).send({ error: "file_not_found" });
      }
      return file;
    }
    const files = await opts.pipelines.listFiles();
    return { files, total: files.length };
  });
}
