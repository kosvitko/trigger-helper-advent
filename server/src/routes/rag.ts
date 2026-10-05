import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RagService, RagUnavailableError } from "../services/rag/store.js";

/**
 * Day21 read-only RAG endpoints (design D-6/§3.3). GETs are outside the IP
 * rate limiter by design (the plugin only throttles costly POSTs).
 * Any index/embedder problem → 503 {error} (degrade-not-crash, day20 rule).
 *
 * 04.10 (гейт 261004 §7): search/ask/eval-роуты сняты вместе со старым UI;
 * сервисы RAG остаются — rag-tool агента (день 25) использует их напрямую.
 */

export interface RagRoutesOptions {
  rag: RagService;
}

function unavailable(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof RagUnavailableError) {
    req.log.warn({ err: err.message }, "rag unavailable — 503");
    return reply.code(503).send({ error: "rag index unavailable", message: err.message });
  }
  throw err;
}

export async function registerRagRoutes(app: FastifyInstance, opts: RagRoutesOptions): Promise<void> {
  app.get("/api/rag/stats", async (req, reply) => {
    const t0 = Date.now();
    try {
      const stats = await opts.rag.stats();
      return { ...stats, latencyMs: Date.now() - t0 };
    } catch (err) {
      return unavailable(req, reply, err);
    }
  });
}
