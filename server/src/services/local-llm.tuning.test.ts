import { describe, expect, it } from "vitest";
import {
  LOCAL_LLM_NUM_PREDICT,
  LOCAL_LLM_RAG_PROMPT,
  LOCAL_LLM_SYSTEM_PROMPT,
  LOCAL_LLM_TEMPERATURE,
  localLlmTuning,
  localLlmWireOptions,
  localRagAssemble,
  localSystemPrompt,
} from "./local-llm.js";
import type { RagChunk, SearchHit } from "./rag/store.js";

/**
 * День 29 — юнит-тесты тюнинг-профиля локальной ветки (proposals 261010
 * §3.1-1/2): wire-options из каталога, override-семантика baseline-arm'а,
 * выбор системного промпта под кейс, бюджет сборки контекста.
 * Живой рантайм не нужен — проверяются чистые функции.
 */

describe("localLlmWireOptions (день 29: тюнинг-профиль)", () => {
  it("по умолчанию для 1.5b — темп 0.2, num_predict 320, num_ctx 4096", () => {
    expect(localLlmWireOptions("qwen2.5:1.5b")).toEqual({
      temperature: 0.2,
      num_ctx: 4096,
      num_predict: 320,
    });
  });

  it("по умолчанию для 0.5b — прод-профиль дня 28 (num_ctx 2048)", () => {
    expect(localLlmWireOptions("qwen2.5:0.5b")).toEqual({
      temperature: LOCAL_LLM_TEMPERATURE,
      num_ctx: 2048,
      num_predict: LOCAL_LLM_NUM_PREDICT,
    });
  });

  it("override заменяет профиль по заданным полям: {numCtx: 2048} — wire-формат дня 28 без temperature/num_predict", () => {
    expect(localLlmWireOptions("qwen2.5:1.5b", { numCtx: 2048 })).toEqual({
      num_ctx: 2048,
    });
  });

  it("override с явной температурой едет в wire как есть", () => {
    expect(
      localLlmWireOptions("qwen2.5:1.5b", { numCtx: 2048, temperature: 0.8 }),
    ).toEqual({ num_ctx: 2048, temperature: 0.8 });
  });
});

describe("localLlmTuning", () => {
  it("неизвестный id — консервативный дефолт дня 28 (2048/1000)", () => {
    expect(localLlmTuning("unknown-model")).toEqual({
      numCtx: 2048,
      ragPromptTokenBudget: 1000,
    });
  });

  it("бюджет контекста 1.5b — 2000 ток (в контекст 3–6 кусков)", () => {
    expect(localLlmTuning("qwen2.5:1.5b").ragPromptTokenBudget).toBe(2000);
  });
});

describe("localSystemPrompt (день 29: промпт под кейс)", () => {
  it("без контекста — базовый промпт", () => {
    expect(localSystemPrompt({})).toBe(LOCAL_LLM_SYSTEM_PROMPT);
  });

  it("с контекстом — RAG-промпт + SEC-F3-блок после него", () => {
    const out = localSystemPrompt({ context: "ДАННЫЕ: подостная мышца…" });
    expect(out.startsWith(LOCAL_LLM_RAG_PROMPT)).toBe(true);
    expect(out).toContain("ДАННЫЕ: подостная мышца…");
  });

  it("override (baseline-arm) — старый промпт + контекст", () => {
    const out = localSystemPrompt({
      systemPrompt: LOCAL_LLM_SYSTEM_PROMPT,
      context: "ДАННЫЕ: …",
    });
    expect(out).toBe(`${LOCAL_LLM_SYSTEM_PROMPT}\n\nДАННЫЕ: …`);
  });
});

describe("localRagAssemble (день 29: бюджет/k сборки)", () => {
  const chunk = (id: string, text: string): SearchHit => ({
    chunk: {
      chunk_id: id,
      source: `points/${id}.md`,
      file: `${id}.md`,
      title: `Мышца ${id}`,
      section: "",
      position: 0,
      text,
      vector: [],
    } satisfies RagChunk,
    score: 0.9,
  });

  it("первый чанк остаётся всегда, даже когда не влезает в бюджет", () => {
    const hits = [chunk("big-1", "а".repeat(10_000))];
    const asm = localRagAssemble(hits, { promptTokenBudget: 100 });
    expect(asm.injectedCount).toBe(1);
    expect(asm.sources[0]?.chunk_id).toBe("big-1");
  });

  it("хвост выбрасывается первым: маленький первый + огромный второй при малом бюджете → 1 кусок", () => {
    const hits = [chunk("small-1", "короткий текст"), chunk("big-2", "б".repeat(10_000))];
    const asm = localRagAssemble(hits, { promptTokenBudget: 300 });
    expect(asm.injectedCount).toBe(1);
    expect(asm.sources[0]?.chunk_id).toBe("small-1");
  });

  it("большой бюджет пропускает оба куска (день 29: 2000 вместо 1000)", () => {
    const hits = [chunk("small-1", "короткий текст"), chunk("mid-2", "в".repeat(2_000))];
    const tight = localRagAssemble(hits, { promptTokenBudget: 300 });
    const wide = localRagAssemble(hits, { promptTokenBudget: 2_000 });
    expect(tight.injectedCount).toBe(1);
    expect(wide.injectedCount).toBe(2);
  });

  it("k режет список раньше бюджета", () => {
    const hits = [chunk("a", "текст"), chunk("b", "текст"), chunk("c", "текст")];
    const asm = localRagAssemble(hits, { k: 2, promptTokenBudget: 10_000 });
    expect(asm.injectedCount).toBe(2);
  });

  it("контекст-блок — SEC-F3-форма с заголовком источника", () => {
    const asm = localRagAssemble([chunk("masseter", "техника массажа")], {});
    expect(asm.contextBlock).toContain("[points/masseter.md");
    expect(asm.contextBlock).toContain("техника массажа");
  });
});
