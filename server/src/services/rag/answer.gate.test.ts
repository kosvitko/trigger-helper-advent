/**
 * UNIT — RAG-гейты (гейт 261009 Pick A, кусок 4): validateQuotes + dontKnow
 * через stub rankAll (score < порога из tune-dontknow.json). Без HF/эмбеддингов,
 * без DOM (рельса: UI-метки — client stripSourceLabels).
 */
import { describe, expect, it, vi } from "vitest";
import type { DeepSeekService } from "../deepseek.js";
import type { UsageLedgerService } from "../usage-ledger.js";
import {
  createRagAnswerService,
  validateQuotes,
  type InjectedChunk,
} from "./answer.js";
import type { Reranker } from "./rerank.js";
import type { QueryRewriter } from "./rewrite.js";
import type { RagService, SearchHit } from "./store.js";

function injectedMap(
  entries: Array<[string, InjectedChunk]>,
): Map<string, InjectedChunk> {
  return new Map(entries);
}

describe("validateQuotes", () => {
  const chunkText =
    "Триггерная точка в верхней трапеции даёт боль в виске и за глазом.";
  const injected = injectedMap([
    [
      "c1",
      {
        text: chunkText,
        source: "travell",
        section: "trapezius",
      },
    ],
  ]);

  it("принимает непрерывный фрагмент из injected chunk", () => {
    const { valid, dropped } = validateQuotes(
      [{ quote: "боль в виске и за глазом", chunk_id: "c1" }],
      injected,
    );
    expect(dropped).toBe(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].chunk_id).toBe("c1");
    expect(valid[0].source).toBe("travell");
    expect(valid[0].section).toBe("trapezius");
    expect(valid[0].paraphrase).toBe(true);
  });

  it("дропает цитату, которой нет в чанке", () => {
    const { valid, dropped } = validateQuotes(
      [{ quote: "рецепт борща на четыре порции", chunk_id: "c1" }],
      injected,
    );
    expect(valid).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("ребиндит hallucinated chunk_id при ровно одном совпадении", () => {
    const { valid, dropped } = validateQuotes(
      [{ quote: "верхней трапеции", chunk_id: "wrong-id" }],
      injected,
    );
    expect(dropped).toBe(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].chunk_id).toBe("c1");
  });
});

describe("RagAnswerService.ask — dontKnow гейт", () => {
  it("top-1 ниже порога → meta.dontKnow, usage=0, LLM не зовётся", async () => {
    const hit: SearchHit = {
      score: 0.1,
      chunk: {
        chunk_id: "low",
        source: "x",
        file: "x.md",
        title: "t",
        section: "s",
        position: 0,
        text: "irrelevant",
        vector: [],
      },
    };
    const rag = {
      rankAll: vi.fn(async () => ({
        index: { model: "x", dim: 1, strategy: "fixed", builtAt: "", chunks: [] },
        hits: [hit],
      })),
    } as unknown as RagService;

    const deepSeek = {
      chat: vi.fn(async () => {
        throw new Error("LLM must not be called on dontKnow path");
      }),
    } as unknown as DeepSeekService;

    const ledger = {
      record: vi.fn(async () => ({})),
    } as unknown as UsageLedgerService;

    const reranker = {
      ensureReady: vi.fn(),
      rerank: vi.fn(),
    } as unknown as Reranker;
    const rewriter = {
      rewriteQueries: vi.fn(),
    } as unknown as QueryRewriter;

    const svc = createRagAnswerService({
      rag,
      deepSeek,
      ledger,
      reranker,
      rewriter,
    });

    const result = await svc.ask({
      q: "какая завтра погода в Москве",
      mode: "rag",
      strategy: "fixed",
      k: 5,
    });

    expect(result.meta.dontKnow).toBe(true);
    expect(result.usage.total_tokens).toBe(0);
    expect(result.usage.estimated_cost_rub).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.quotes).toEqual([]);
    expect(result.answer).toMatch(/Не знаю/);
    expect(result.answer).toContain("какая завтра погода в Москве");
    expect(deepSeek.chat).not.toHaveBeenCalled();
    expect(rag.rankAll).toHaveBeenCalledOnce();
    expect(ledger.record).toHaveBeenCalled();
  });
});
