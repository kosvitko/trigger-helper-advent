import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Env } from "../../config/env.js";
import { repoRoot, resolveFromRoot } from "./paths.js";
import { RagUnavailableError, type SearchHit } from "./store.js";

/**
 * Day23 reranker (design D-2/D-3): a LOCAL cross-encoder as the second stage
 * over the cosine ranking. Model pinned by code — web-verified 30.09:
 * BGLAW/bge-reranker-v2-m3-onnx-defaulttask (BAAI/bge-reranker-v2-m3,
 * multilingual incl. RU, Apache-2.0; onnx/model_quantized.onnx ~544 MiB is the
 * ONLY loadable file — the repo's fp32 entry is a broken stub, always dtype
 * "q8").
 *
 * The manual AutoTokenizer + AutoModelForSequenceClassification pattern is
 * mandatory: transformers.js v4 has no "text-ranking" pipeline, and the
 * text-classification pipeline applies softmax, which for a 1-logit
 * cross-encoder yields ≈1.0 every time (pipeline scores unusable). Same
 * lazy-init sequence as embeddings.ts: import → env.cacheDir BEFORE the first
 * load → mkdir → q8; batch ≤8 pairs (568M params @512 tok — ~570 MB + ORT
 * arena; F-04 batch fix).
 *
 * Threshold + pool are OWNED by the committed tune artifact
 * data/rag/tune-rerank.json (npm run rag:tune, D-3/D-7): missing/invalid
 * artifact → RagUnavailableError → 503 for rerank arms ONLY (mode-scoped
 * degradation, F-04-1/base and rewrite arms keep working). The artifact is
 * committed to git and validated with zod — same trust level as
 * rag-index-*.json, not user input (F-04-4).
 */

const RERANK_MODEL = "BGLAW/bge-reranker-v2-m3-onnx-defaulttask";
const BATCH_SIZE = 8;
const MAX_LENGTH = 512; // v2-m3 max_position_embeddings=8194 → truncate explicitly

const tuneArtifactSchema = z.object({
  pool: z.number().int().min(1).max(220),
  threshold: z
    .object({
      value: z.number().min(0).max(1),
      /** "absolute-sigmoid" | "relative-margin" (D-3 ladder rung 2). */
      kind: z.string().min(1),
    })
    .passthrough(),
});

type TuneArtifact = z.infer<typeof tuneArtifactSchema>;

interface TensorLike {
  tolist(): number[][];
}

interface TokenizerLike {
  (texts: string[], options: {
    text_pair?: string[];
    padding?: boolean;
    truncation?: boolean;
    max_length?: number;
  }): Promise<unknown>;
}

interface ModelLike {
  (inputs: unknown): Promise<{ logits: TensorLike }>;
}

interface TransformersModule {
  AutoTokenizer: { from_pretrained(model: string): Promise<TokenizerLike> };
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, options: { dtype: string }): Promise<ModelLike>;
  };
  env: { cacheDir: string };
}

let transformersPromise: Promise<TransformersModule> | null = null;

async function loadTransformers(env: Env): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
      // Same cache as the day-21 embedder (var/ is gitignored and never
      // deployed — the VPS pays the download on the first request, D-11).
      const cacheDir = resolveFromRoot(env.RAG_CACHE_DIR, "var/hf-cache");
      await fs.mkdir(cacheDir, { recursive: true });
      mod.env.cacheDir = cacheDir;
      return mod;
    })();
  }
  return transformersPromise;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Model-only scorer — no tune artifact needed (rag:tune itself uses this to
 *  CREATE the artifact). Lazy load: boot never touches the model. */
export interface RerankScorer {
  readonly model: string;
  /** Sigmoid relevance 0..1 of query against each text, in input order. */
  scoreAll(query: string, texts: string[]): Promise<number[]>;
}

export async function createRerankScorer(env: Env): Promise<RerankScorer> {
  let pending: Promise<{ tokenizer: TokenizerLike; model: ModelLike }> | null = null;

  const load = (): Promise<{ tokenizer: TokenizerLike; model: ModelLike }> => {
    if (!pending) {
      pending = (async () => {
        try {
          const mod = await loadTransformers(env);
          const tokenizer = await mod.AutoTokenizer.from_pretrained(RERANK_MODEL);
          const model = await mod.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
            dtype: "q8",
          });
          return { tokenizer, model };
        } catch (err) {
          pending = null; // house pending-promise pattern: failed load → retry next call
          throw new RagUnavailableError(
            `reranker load failed for ${RERANK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
    return pending;
  };

  return {
    model: RERANK_MODEL,
    async scoreAll(query: string, texts: string[]): Promise<number[]> {
      if (texts.length === 0) return [];
      const { tokenizer, model } = await load();
      const scores: number[] = [];
      for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
        const batch = texts.slice(offset, offset + BATCH_SIZE);
        // Cross-encoder pair (query, doc): transformers.js requires text and
        // text_pair arrays of the SAME length → repeat the query per doc.
        const inputs = await tokenizer(
          batch.map(() => query),
          {
            text_pair: batch,
            padding: true,
            truncation: true,
            max_length: MAX_LENGTH,
          },
        );
        const out = await model(inputs);
        const logits = out.logits.tolist(); // [batch, 1]
        for (const row of logits) scores.push(sigmoid(row[0] ?? 0));
      }
      return scores;
    },
  };
}

export interface RerankResult {
  /** Filtered + re-sorted by the reranker's sigmoid (score replaced, round4 —
   *  D-5: sources[].score is always the score the list is sorted by). */
  hits: SearchHit[];
  /** Hits after the threshold cut, before the k_final slice (D-3/F-5). */
  kept: number;
  latencyMs: number;
  pool: number;
  threshold: number;
}

export interface Reranker {
  readonly model: string;
  /** Ask-pipeline precheck (F-04-2): loads model + tune artifact BEFORE any
   *  rewrite spend; failure → RagUnavailableError → mode-scoped 503. */
  ensureReady(): Promise<void>;
  /** Second stage: top-pool → cross-encoder scores → threshold cut → re-sort.
   *  Anti-regression guard: the post-rerank rank-1 never drops (D-3). */
  rerank(query: string, hits: SearchHit[]): Promise<RerankResult>;
}

export function createReranker(env: Env): Reranker {
  // D-11 hardening (OOM measured 01.10): the host can switch the reranker off
  // — rerank/full arms then 503 cleanly BEFORE any model load instead of the
  // whole process being OOM-killed mid-request. Nothing eager is created when
  // disabled (an eagerly-rejected promise would crash boot as unhandled).
  const disabled =
    env.RAG_RERANK_ENABLED === "0" || (env.RAG_RERANK_ENABLED ?? "").toLowerCase() === "false";
  let scorerPromise: Promise<RerankScorer> | null = null;
  let artifactPending: Promise<{ scorer: RerankScorer; artifact: TuneArtifact }> | null = null;

  const ensureReady = (): Promise<{ scorer: RerankScorer; artifact: TuneArtifact }> => {
    if (disabled) {
      return Promise.reject(
        new RagUnavailableError(
          "reranker disabled on this host (RAG_RERANK_ENABLED=0) — база/rewrite работают, полный этап считается локально",
        ),
      );
    }
    if (!artifactPending) {
      artifactPending = (async () => {
        try {
          if (!scorerPromise) scorerPromise = createRerankScorer(env);
          const scorer = await scorerPromise;
          const artifactPath = path.join(repoRoot, "data", "rag", "tune-rerank.json");
          let raw: string;
          try {
            raw = await fs.readFile(artifactPath, "utf8");
          } catch {
            throw new RagUnavailableError(
              "tune artifact missing: data/rag/tune-rerank.json — run npm run rag:tune (design D-3)",
            );
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(raw);
          } catch {
            throw new RagUnavailableError("tune artifact corrupt (JSON.parse)");
          }
          const parsed = tuneArtifactSchema.safeParse(parsedJson);
          if (!parsed.success) {
            throw new RagUnavailableError(`tune artifact schema mismatch: ${parsed.error.message}`);
          }
          return { scorer, artifact: parsed.data };
        } catch (err) {
          artifactPending = null; // failed artifact load → retry on next call
          throw err;
        }
      })();
    }
    return artifactPending;
  };

  return {
    model: RERANK_MODEL,
    ensureReady(): Promise<void> {
      return ensureReady().then(() => undefined);
    },
    async rerank(query: string, hits: SearchHit[]): Promise<RerankResult> {
      const { scorer, artifact } = await ensureReady();
      const pool = Math.min(artifact.pool, hits.length);
      const top = hits.slice(0, pool);
      const t0 = Date.now();
      const scores = await scorer.scoreAll(query, top.map((h) => h.chunk.text));
      const latencyMs = Date.now() - t0;
      const scored = top
        .map((hit, i) => ({ hit, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
      // D-3 threshold ladder: "absolute-sigmoid" (score ≥ value) or
      // "relative-margin" (score ≥ top1 − value — per-query scale varies
      // wildly, tune 30.09/01.10 measured no global gap → rung 2).
      const top1 = scored.length ? scored[0].score : 0;
      const kind = artifact.threshold.kind;
      const cutoff =
        kind === "relative-margin" ? top1 - artifact.threshold.value : artifact.threshold.value;
      const keptList = scored.filter((s) => s.score >= cutoff);
      if (keptList.length === 0 && scored.length > 0) {
        keptList.push(scored[0]); // D-3 guard: never drop the post-rerank rank-1
      }
      return {
        hits: keptList.map(({ hit, score }) => ({ chunk: hit.chunk, score: round4(score) })),
        kept: keptList.length,
        latencyMs,
        pool: artifact.pool,
        threshold: artifact.threshold.value,
      };
    },
  };
}
