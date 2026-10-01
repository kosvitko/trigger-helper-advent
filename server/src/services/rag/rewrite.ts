import { z } from "zod";
import type { LlmUsage } from "@trigger-helper/shared";
import type { ChatMessage, DeepSeekService } from "../deepseek.js";

/**
 * Day23 multi-query rewrite (design D-4): ONE deepseek-chat call (temp 0,
 * maxTokens 200, timeout 30 s) turns the reader's colloquial question into
 * 2–3 retrieval queries in corpus vocabulary (muscle names, symptom terms).
 *
 * OWN try/catch — this call never surfaces as 502 (answer.ts chat() rethrows,
 * the route maps that to 502; the rewrite must degrade instead, F-04-3): any
 * failure (timeout/5xx/parse) → fallback to the original question with
 * meta.rewrite = {fallback: true, error}.
 *
 * Red-team guard rails baked into the pipeline (answer.ts/store.ts): variants
 * feed RETRIEVAL only — the answer call keeps the original question; the union
 * with the original query is a per-chunk max in store.rankByQueries, so the
 * original can never be displaced.
 *
 * The prompt MUST contain the literal word "json" plus a format example —
 * DeepSeek JSON Output requirement (F-05-4): without it the API errors and
 * every call would silently fall back, making the matrix "prove" rewrite
 * useless for a wrong reason.
 */

const REWRITE_MODEL = "deepseek-chat";
const REWRITE_TEMPERATURE = 0;
const REWRITE_MAX_TOKENS = 200;
const REWRITE_TIMEOUT_MS = 30_000;
const MAX_VARIANTS = 3;

const REWRITE_SYSTEM = [
  "Ты превращаешь вопрос читателя в поисковые запросы для базы знаний о триггерных точках (названия мышц по-русски и на латыни, симптомы, зоны отражённой боли).",
  'Дай 2–3 варианта короткого поискового запроса из словаря базы. Верни только json вида {"queries": ["запрос 1", "запрос 2"]} — без пояснений.',
].join("\n");

const queriesSchema = z.object({
  queries: z.array(z.string().trim().min(1)).min(1).max(5),
});

export interface RewriteResult {
  /** Variant queries only — the original question is always kept by the
   *  caller/store union (D-4 guard a: never replace, only add). */
  queries: string[];
  usage: LlmUsage | null;
  latencyMs: number;
  fallback: boolean;
  error?: string;
}

export interface QueryRewriter {
  rewriteQueries(q: string): Promise<RewriteResult>;
}

export function createRewriteQueries(deepSeek: DeepSeekService): QueryRewriter {
  return {
    async rewriteQueries(q: string): Promise<RewriteResult> {
      const t0 = Date.now();
      const messages: ChatMessage[] = [
        { role: "system", content: REWRITE_SYSTEM },
        { role: "user", content: q },
      ];
      try {
        const result = await deepSeek.chat(messages, {
          model: REWRITE_MODEL,
          temperature: REWRITE_TEMPERATURE,
          maxTokens: REWRITE_MAX_TOKENS,
          timeoutMs: REWRITE_TIMEOUT_MS,
          jsonMode: true,
        });
        // Lenient parse: the model may wrap JSON in code fences or prose.
        const match = result.reply.match(/\{[\s\S]*\}/);
        const parsed = queriesSchema.safeParse(JSON.parse(match ? match[0] : result.reply));
        if (!parsed.success) {
          return {
            queries: [],
            usage: result.usage,
            latencyMs: Date.now() - t0,
            fallback: true,
            error: "json parse failed",
          };
        }
        return {
          queries: parsed.data.queries.slice(0, MAX_VARIANTS),
          usage: result.usage,
          latencyMs: Date.now() - t0,
          fallback: false,
        };
      } catch (err) {
        return {
          queries: [],
          usage: null,
          latencyMs: Date.now() - t0,
          fallback: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
