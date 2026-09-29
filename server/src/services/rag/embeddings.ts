import fs from "node:fs/promises";
import type { Env } from "../../config/env.js";
import { resolveFromRoot } from "./paths.js";

/**
 * Day21 embeddings (design D-2): local ONNX via @huggingface/transformers.
 * The model is a PARAMETER — the build script passes env.RAG_EMBEDDINGS_MODEL,
 * the store passes the model recorded in the index header (pass 05, F-1:
 * query and passages must provably share one vector space).
 * Init sequence: lazy import → set env.cacheDir BEFORE any pipeline() call →
 * mkdir cache (do not rely on the library's internal mkdir, pass 04 F-F) →
 * create the pipeline lazily on first embed.
 */

export const DEFAULT_EMBEDDINGS_MODEL = "Xenova/multilingual-e5-small";

/** e5 requires "query: " / "passage: " prefixes (model card FAQ). */
const QUERY_PREFIX = "query: ";
const PASSAGE_PREFIX = "passage: ";

/** Batch size per extractor call — bounds the ONNX arena on CPU builds. */
const BATCH_SIZE = 16;

interface TensorLike {
  tolist(): number[][];
}

type ExtractorOptions = {
  pooling: "mean";
  normalize: boolean;
  truncation?: boolean;
  max_length?: number;
};

interface ExtractorLike {
  (texts: string[], options: ExtractorOptions): Promise<TensorLike>;
}

interface TransformersModule {
  pipeline(task: "feature-extraction", model: string, options?: { dtype?: string }): Promise<ExtractorLike>;
  env: { cacheDir: string };
}

export interface Embedder {
  readonly model: string;
  embedPassages(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

let transformersPromise: Promise<TransformersModule> | null = null;

async function loadTransformers(env: Env): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
      // Resolve + create the cache dir BEFORE the first pipeline() call
      // (design D-2 sequence; var/ is gitignored and never deployed — fresh
      // clones and the VPS both start without it).
      const cacheDir = resolveFromRoot(env.RAG_CACHE_DIR, "var/hf-cache");
      await fs.mkdir(cacheDir, { recursive: true });
      mod.env.cacheDir = cacheDir;
      return mod;
    })();
  }
  return transformersPromise;
}

export async function createEmbedder(env: Env, model: string): Promise<Embedder> {
  const { pipeline } = await loadTransformers(env);
  // dtype q8: ~4x smaller than fp32 with negligible retrieval loss at our scale.
  const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });

  async function run(texts: string[], prefix: string, onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
      const batch = texts.slice(offset, offset + BATCH_SIZE).map((t) => prefix + t);
      const output = await extractor(batch, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: 512,
      });
      vectors.push(...output.tolist());
      onProgress?.(Math.min(offset + BATCH_SIZE, texts.length), texts.length);
    }
    return vectors;
  }

  return {
    model,
    embedPassages: (texts, onProgress) => run(texts, PASSAGE_PREFIX, onProgress),
    embedQuery: async (query) => (await run([query], QUERY_PREFIX))[0],
  };
}
