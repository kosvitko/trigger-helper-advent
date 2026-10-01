import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RAG_STRATEGIES, RagService, RagUnavailableError } from "../services/rag/store.js";
import { repoRoot } from "../services/rag/paths.js";
import type { RagAnswerService } from "../services/rag/answer.js";
import type { Env } from "../config/env.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";
import {
  applyCostAwareThrottle,
  getBudgetSnapshot,
} from "../services/cost-aware-throttle.js";

/**
 * Day21 read-only RAG endpoints (design D-6/§3.3). GETs are outside the IP
 * rate limiter by design (the plugin only throttles costly POSTs).
 * Any index/embedder problem → 503 {error} (degrade-not-crash, day20 rule).
 *
 * Day22 (design D-1/D-5): POST /api/rag/ask — costly LLM call, so it MUST be
 * listed in plugins/ip-rate-limit.ts isRateLimitedPath and goes through the
 * cost-aware budget throttle like /api/ask (F-05-1: env+ledger live in opts).
 */

const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  // Day22: default strategy = structured — на корпусе точек он лучше по
  // ответам при нормированном k (замер 30.09: 0.80/90% vs fixed 0.77/90%).
  strategy: z.enum(RAG_STRATEGIES).default("structured"),
  k: z.coerce.number().int().min(1).max(10).default(3),
  /** Day21 fix-up: full=1 adds the complete chunk text to each hit
   *  (UI "показать целиком"); default keeps the excerpt-only envelope. */
  full: z.enum(["0", "1"]).default("0"),
});

const askBodySchema = z.object({
  q: z.string().trim().min(1).max(2000),
  mode: z.enum(["rag", "baseline"]),
  // Day22 замер: structured + k=12 — лучший ответ-уровень (0.80, PASS 6/10,
  // retrieval 90%); k=12 — нормировка по объёму контекста (мелкие секции).
  strategy: z.enum(RAG_STRATEGIES).default("structured"),
  k: z.coerce.number().int().min(1).max(15).default(12),
  // Day23 (design D-5): rag-stage flags — base arm (false/false) = day-22 canon.
  // Rerank arms ignore route k inside the service (k_final const, D-3).
  rerank: z.boolean().default(false),
  rewrite: z.boolean().default(false),
});

export interface RagRoutesOptions {
  rag: RagService;
  /** Day22 ask service (createRagAnswerService). */
  ragAnswer: RagAnswerService;
  /** Budget throttle needs both (F-05-1) — same trio as AskRouteDeps. */
  env: Env;
  ledger: UsageLedgerService;
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

  /** Day22 (design D-1/D-5): question → chunks → LLM, two fair modes.
   *  400 zod · 429 budget · 503 index/embedder · 502 LLM failure. */
  app.post("/api/rag/ask", async (req, reply) => {    const parsed = askBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const budget = await getBudgetSnapshot(opts.ledger, opts.env);
    if ((await applyCostAwareThrottle(reply, budget)) === "rejected") {
      return;
    }
    try {
      const result = await opts.ragAnswer.ask(parsed.data);
      return result;
    } catch (err) {
      if (err instanceof RagUnavailableError) {
        return unavailable(req, reply, err);
      }
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "rag ask — 502");
      return reply.code(502).send({
        error: "llm failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Day22: committed eval artifact (rag:eval output) — the screencast shows
   *  the 10-question comparison as a chat card, not raw files. */
  app.get("/api/rag/eval", async (req, reply) => {
    const file = path.join(repoRoot, "data", "rag", "eval-answers.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      return { ok: true, eval: JSON.parse(raw) };
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "rag eval — 404");
      return reply.code(404).send({
        error: "eval artifact missing",
        message: "запустите npm run rag:eval — артефакт data/rag/eval-answers.json появится",
      });
    }
  });
}
