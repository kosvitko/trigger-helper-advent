/**
 * UNIT — api.ragStats: zod-контракт «Поиск по базе» (RagStatsResponseSchema).
 * Фикстура — РЕАЛЬНЫЙ прод-ответ GET /api/rag/stats (30.09.2026, h3llo),
 * дословно (см. e2eRagStats в e2e/fixtures.ts). Директива заказчика после
 * бага «прочерков»: экран писали против выдуманной формы без контракта —
 * поэтому прод-форма обязана парситься, экстра-поля (dim, latencyMs,
 * compare.generatedAt) не ломают parse, чужая форма → управляемая ApiError.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, api } from "./api";
import { e2eRagStats } from "../../e2e/fixtures";
import { stubFetch } from "../test/http";

beforeEach(() => {
  stubFetch([{ url: "/api/rag/stats", json: e2eRagStats() }]);
});

describe("api.ragStats · контракт «Поиск по базе»", () => {
  it("реальный прод-ответ парсится: 2 индекса, чанки 128/220, compare по стратегиям", async () => {
    const stats = await api.ragStats();

    expect(stats.ok).toBe(true);
    expect(stats.indexes).toHaveLength(2);
    expect(stats.indexes[0]).toMatchObject({
      strategy: "fixed",
      model: "Xenova/multilingual-e5-small",
      chunks: 128,
      fileCount: 43,
    });
    expect(stats.indexes[1]).toMatchObject({ strategy: "structured", chunks: 220 });
    expect(stats.indexes[0]?.builtAt).toBe("2026-09-30T08:41:44.756Z");

    const byStrategy = stats.compare?.byStrategy ?? {};
    expect(byStrategy.structured?.hitAt1).toBeCloseTo(0.6667, 4);
    expect(byStrategy.fixed).toMatchObject({ hitAt1: 0.5, hitAt5: 0.9167, mrr: 0.6736 });
    expect(byStrategy.structured).toMatchObject({ hitAt5: 0.8333, mrr: 0.7619 });
  });

  it("экстра-поля прода (dim, latencyMs, compare.generatedAt) не ломают parse и срезаются схемой", async () => {
    const stats = await api.ragStats(); // resolve, а не ApiError — главное

    // parse прошёл именно через схему: неизвестные ключи в вывод не прошли
    expect(stats.indexes[0]).not.toHaveProperty("dim");
    expect(stats).not.toHaveProperty("latencyMs");
    expect(stats.compare).not.toHaveProperty("generatedAt");
  });

  it("чужая форма ({ok:false, indexes:'x'}) → ApiError «Неожиданный формат ответа сервера» (502), не мусор в UI", async () => {
    stubFetch([{ url: "/api/rag/stats", json: { ok: false, indexes: "x" } }]);

    const err = await api.ragStats().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Неожиданный формат ответа сервера");
    expect((err as ApiError).status).toBe(502);
  });
});
