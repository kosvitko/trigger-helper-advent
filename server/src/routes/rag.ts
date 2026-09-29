import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RAG_STRATEGIES, RagService, RagUnavailableError } from "../services/rag/store.js";

/**
 * Day21 read-only RAG endpoints (design D-6/§3.3). GETs are outside the IP
 * rate limiter by design (the plugin only throttles costly POSTs).
 * Any index/embedder problem → 503 {error} (degrade-not-crash, day20 rule).
 */

const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  strategy: z.enum(RAG_STRATEGIES).default("fixed"),
  k: z.coerce.number().int().min(1).max(10).default(3),
  /** Day21 fix-up: full=1 adds the complete chunk text to each hit
   *  (UI "показать целиком"); default keeps the excerpt-only envelope. */
  full: z.enum(["0", "1"]).default("0"),
});

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

  app.get("/api/rag/search", async (req, reply) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query", details: parsed.error.flatten() });
    }
    const { q, strategy, k, full } = parsed.data;
    const withFull = full === "1";
    const t0 = Date.now();
    try {
      const { index, hits } = await opts.rag.search(q, strategy, k);
      return {
        ok: true,
        query: q,
        strategy,
        k,
        results: hits.map(({ chunk, score }) => ({
          chunk_id: chunk.chunk_id,
          score: Math.round(score * 10_000) / 10_000,
          source: chunk.source,
          file: chunk.file,
          title: chunk.title,
          section: chunk.section,
          excerpt: chunk.text.slice(0, 300),
          ...(withFull ? { text: chunk.text } : {}),
        })),
        meta: {
          model: index.model,
          dim: index.dim,
          chunks: index.chunks.length,
          builtAt: index.builtAt,
          latencyMs: Date.now() - t0,
        },
      };
    } catch (err) {
      return unavailable(req, reply, err);
    }
  });
}
