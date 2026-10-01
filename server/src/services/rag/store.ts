import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Env } from "../../config/env.js";
import { createEmbedder, type Embedder } from "./embeddings.js";
import { resolveFromRoot } from "./paths.js";

/**
 * Day21 store (design D-3/D-6, §3.1): JSON index load + validation, stats,
 * cosine search. Degrade-not-crash: any index problem (missing file, corrupt
 * JSON, schema mismatch, dim mismatch, embedder failure) is a
 * RagUnavailableError → routes answer 503 and the server lives on (day20 rule).
 *
 * Seam for days 22–25: search() returns FULL chunks (text + all metadata);
 * excerpt clipping is a route/UI concern only (pass 04, F-B).
 */

export const RAG_STRATEGIES = ["fixed", "structured"] as const;
export type RagStrategy = (typeof RAG_STRATEGIES)[number];

const chunkSchema = z.object({
  chunk_id: z.string().min(1),
  source: z.string().min(1),
  file: z.string().min(1),
  title: z.string(),
  section: z.string(),
  position: z.number().int().nonnegative(),
  text: z.string(),
  vector: z.array(z.number()),
});

const indexSchema = z.object({
  model: z.string().min(1),
  dim: z.number().int().positive(),
  strategy: z.enum(RAG_STRATEGIES),
  builtAt: z.string().min(1),
  chunks: z.array(chunkSchema),
});

export type RagChunk = z.infer<typeof chunkSchema>;
export type RagIndex = z.infer<typeof indexSchema>;

export const compareStatsSchema = z.object({
  generatedAt: z.string().min(1),
  model: z.string().min(1),
  probes: z.number().int().nonnegative(),
  byStrategy: z.object({
    fixed: z.object({ hitAt1: z.number(), hitAt5: z.number(), mrr: z.number() }),
    structured: z.object({ hitAt1: z.number(), hitAt5: z.number(), mrr: z.number() }),
  }),
  buildStats: z.object({
    fixed: z
      .object({
        chunks: z.number().int().nonnegative(),
        avgChars: z.number(),
        medianChars: z.number(),
        p95Chars: z.number(),
        splitInsideBlockPct: z.number(),
        splitInsideSentencePct: z.number(),
        overlapPct: z.number().nullable(),
        buildTimeMs: z.number().nonnegative(),
      })
      .passthrough(),
    structured: z
      .object({
        chunks: z.number().int().nonnegative(),
        avgChars: z.number(),
        medianChars: z.number(),
        p95Chars: z.number(),
        splitInsideBlockPct: z.number(),
        splitInsideSentencePct: z.number(),
        overlapPct: z.number().nullable(),
        buildTimeMs: z.number().nonnegative(),
      })
      .passthrough(),
  }),
});

export type CompareStats = z.infer<typeof compareStatsSchema>;

export class RagUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RagUnavailableError";
  }
}

/** Atomic write (tmp + rename) — house pattern (pipelines/scheduler). */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, filePath);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export interface StrategyStats {
  strategy: RagStrategy;
  model: string;
  dim: number;
  builtAt: string;
  chunks: number;
  /** Day21 fix-up (pick C): distinct source paths (full repo-relative — `file`
   *  is a basename and collides across dirs) + sum of chunk text lengths for
   *  the UI pipeline story; structured has no overlap → totalChars ≈ corpus. */
  fileCount: number;
  totalChars: number;
  avgChars: number;
  medianChars: number;
  p95Chars: number;
  splitInsideBlockPct: number;
  splitInsideSentencePct: number;
  overlapPct: number | null;
  buildTimeMs: number | null;
}

export interface SearchHit {
  chunk: RagChunk;
  score: number;
}

export interface ComparePublic {
  generatedAt: string;
  model: string;
  probes: number;
  byStrategy: CompareStats["byStrategy"];
}

export class RagService {
  private readonly indexDir: string;
  private readonly indexCache = new Map<RagStrategy, RagIndex>();
  private readonly embedders = new Map<string, Promise<Embedder>>();

  constructor(private readonly env: Env) {
    this.indexDir = resolveFromRoot(env.RAG_INDEX_DIR, "data/rag");
  }

  private indexFile(strategy: RagStrategy): string {
    return path.join(this.indexDir, `rag-index-${strategy}.json`);
  }

  async loadIndex(strategy: RagStrategy): Promise<RagIndex> {
    const cached = this.indexCache.get(strategy);
    if (cached) return cached;
    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile(strategy), "utf8");
    } catch {
      throw new RagUnavailableError(`index missing: ${strategy}`);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new RagUnavailableError(`index corrupt (JSON.parse): ${strategy}`);
    }
    const parsed = indexSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new RagUnavailableError(`index schema mismatch: ${strategy}`);
    }
    const index = parsed.data;
    if (index.chunks.some((c) => c.vector.length !== index.dim)) {
      throw new RagUnavailableError(`index dim mismatch: ${strategy}`);
    }
    this.indexCache.set(strategy, index);
    return index;
  }

  async stats(): Promise<{ ok: true; indexes: StrategyStats[]; compare: ComparePublic | null }> {
    const indexes = await Promise.all(RAG_STRATEGIES.map((s) => this.loadIndex(s)));
    const compare = await this.loadCompare();
    return {
      ok: true,
      indexes: indexes.map((index) => this.buildStats(index, compare?.buildStats[index.strategy] ?? null)),
      compare: compare
        ? {
            generatedAt: compare.generatedAt,
            model: compare.model,
            probes: compare.probes,
            byStrategy: compare.byStrategy,
          }
        : null,
    };
  }

  private buildStats(index: RagIndex, build: CompareStats["buildStats"]["fixed"] | null): StrategyStats {
    const lengths = index.chunks.map((c) => c.text.length).sort((a, b) => a - b);
    const sum = lengths.reduce((acc, n) => acc + n, 0);
    return {
      strategy: index.strategy,
      model: index.model,
      dim: index.dim,
      builtAt: index.builtAt,
      chunks: index.chunks.length,
      fileCount: new Set(index.chunks.map((c) => c.source)).size,
      totalChars: sum,
      avgChars: lengths.length ? Math.round(sum / lengths.length) : 0,
      medianChars: percentile(lengths, 50),
      p95Chars: percentile(lengths, 95),
      splitInsideBlockPct: build?.splitInsideBlockPct ?? 0,
      splitInsideSentencePct: build?.splitInsideSentencePct ?? 0,
      overlapPct: build?.overlapPct ?? null,
      buildTimeMs: build?.buildTimeMs ?? null,
    };
  }

  private async loadCompare(): Promise<CompareStats | null> {
    try {
      const raw = await fs.readFile(path.join(this.indexDir, "compare-stats.json"), "utf8");
      const parsed = compareStatsSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.warn("[rag/store] compare-stats.json schema mismatch — compare: null");
        return null;
      }
      return parsed.data;
    } catch {
      console.warn("[rag/store] compare-stats.json absent — compare: null");
      return null;
    }
  }

  private async getEmbedder(model: string): Promise<Embedder> {
    let pending = this.embedders.get(model);
    if (!pending) {
      pending = createEmbedder(this.env, model).catch((err: unknown) => {
        this.embedders.delete(model);
        throw new RagUnavailableError(
          `embedder failure for ${model}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      this.embedders.set(model, pending);
    }
    return pending;
  }

  /** Day23 (design D-5): the FULL ranked list — search() minus the slice.
   *  Zero-regression refactor: the score loop is the original one. */
  async rankAll(query: string, strategy: RagStrategy): Promise<{ index: RagIndex; hits: SearchHit[] }> {
    return this.rankByQueries([query], strategy);
  }

  /** Day23 rewrite-union (design D-4/D-5): embed every query (original +
   *  rewrite variants) and keep the PER-CHUNK MAX score — the original
   *  question can never be displaced (red-team guard). The embedder is
   *  private to RagService, so the union lives here, not in answer.ts
   *  (pass 02 F-3). */
  async rankByQueries(queries: string[], strategy: RagStrategy): Promise<{ index: RagIndex; hits: SearchHit[] }> {
    const index = await this.loadIndex(strategy);
    const embedder = await this.getEmbedder(index.model);
    const queryVectors: number[][] = [];
    for (const query of queries) {
      const vector = await embedder.embedQuery(query);
      if (vector.length !== index.dim) {
        throw new RagUnavailableError(`query dim ${vector.length} != index dim ${index.dim}`);
      }
      queryVectors.push(vector);
    }
    // Vectors are stored normalized → dot product == cosine.
    const hits: SearchHit[] = index.chunks.map((chunk) => {
      let best = -Infinity;
      for (const queryVector of queryVectors) {
        let score = 0;
        for (let i = 0; i < index.dim; i++) score += queryVector[i] * chunk.vector[i];
        if (score > best) best = score;
      }
      return { chunk, score: best };
    });
    hits.sort((a, b) => b.score - a.score);
    return { index, hits };
  }

  async search(
    query: string,
    strategy: RagStrategy,
    k: number,
  ): Promise<{ index: RagIndex; hits: SearchHit[] }> {
    const { index, hits } = await this.rankAll(query, strategy);
    return { index, hits: hits.slice(0, k) };
  }
}

export function createRagService(env: Env): RagService {
  return new RagService(env);
}
