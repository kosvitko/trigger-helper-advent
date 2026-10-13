import { describe, expect, it } from "vitest";
import type { LlmUsage } from "@trigger-helper/shared";
import type { ChatResult, DeepSeekService } from "./deepseek.js";
import { parseNameStatus } from "../scripts/review-common.js";
import { createProjectCorpusReader } from "./rag/project-corpus.js";
import type { ProjectSearcher } from "./rag/project-search.js";
import {
  buildRagQuery,
  createReviewService,
  parseReviewReply,
  renderReviewMarkdown,
  truncateDiff,
} from "./review.js";

/** Day32 unit: парсинг вердикта, капы, рендер, retry, RAG-degrade, корпус. */

const validReply = JSON.stringify({
  verdict: "approved",
  summary: "Тривиальные правки документации.",
  bugs: [],
  architecture: [],
  recommendations: ["Добавить пример запуска в README."],
});

function fakeUsage(): LlmUsage {
  return {
    model: "deepseek-chat",
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 100,
  } as LlmUsage;
}

function fakeLlm(replies: string[]): DeepSeekService & { calls: string[] } {
  const calls: string[] = [];
  const service = {
    async chat(messages: Array<{ role: string; content: string }>): Promise<ChatResult> {
      calls.push(messages[messages.length - 1]!.content.slice(0, 40));
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return { reply, usage: fakeUsage(), latency_ms: 5 };
    },
  };
  return Object.assign(service, { calls }) as DeepSeekService & { calls: string[] };
}

const emptySearcher: ProjectSearcher = {
  search: async () => ({ chunks: [], sources: [], topCosine: null }),
};

const baseInput = {
  source: "commit HEAD~1..HEAD",
  title: "",
  files: [{ status: "M", path: "server/src/routes/health.ts" }],
  diff: "+ console.log('x')",
};

describe("parseReviewReply", () => {
  it("принимает валидный approved", () => {
    const parsed = parseReviewReply(validReply);
    expect(parsed.verdict).toBe("approved");
    expect(parsed.recommendations).toHaveLength(1);
  });

  it("принимает changes_requested", () => {
    const parsed = parseReviewReply(
      JSON.stringify({ verdict: "changes_requested", summary: "Баг в diff.", bugs: ["NaN"] }),
    );
    expect(parsed.verdict).toBe("changes_requested");
    expect(parsed.architecture).toEqual([]);
  });

  it("режет не-строки из массивов", () => {
    const parsed = parseReviewReply(
      JSON.stringify({ verdict: "approved", summary: "ок", bugs: [1, "реальный", null] }),
    );
    expect(parsed.bugs).toEqual(["реальный"]);
  });

  it("отвергает не-JSON, плохой verdict и пустой summary", () => {
    expect(() => parseReviewReply("не JSON")).toThrow();
    expect(() => parseReviewReply(JSON.stringify({ verdict: "maybe", summary: "x" }))).toThrow();
    expect(() => parseReviewReply(JSON.stringify({ verdict: "approved", summary: "  " }))).toThrow();
  });
});

describe("truncateDiff", () => {
  it("короткий diff проходит как есть", () => {
    const { diff, truncated } = truncateDiff("+ x");
    expect(diff).toBe("+ x");
    expect(truncated).toBe(false);
  });

  it("длинный diff обрезается с маркером", () => {
    const long = "x".repeat(60_500);
    const { diff, truncated } = truncateDiff(long);
    expect(truncated).toBe(true);
    expect(diff.length).toBeLessThanOrEqual(60_000);
    expect(diff).toContain("diff обрезан");
  });

  it("граница: ровно кап — не обрезается", () => {
    const exact = "y".repeat(60_000);
    expect(truncateDiff(exact).truncated).toBe(false);
  });
});

describe("parseNameStatus (границы статусов)", () => {
  it("R100 нормализуется до R с путём old → new", () => {
    const files = parseNameStatus("R100\tserver/src/a.ts\tserver/src/b.ts");
    expect(files).toEqual([{ status: "R", path: "server/src/a.ts → server/src/b.ts" }]);
  });

  it("обычный M проходит как есть", () => {
    expect(parseNameStatus("M\tREADME.md")).toEqual([{ status: "M", path: "README.md" }]);
  });
});

describe("buildRagQuery", () => {
  it("включает пути первых файлов и пометку об остальных", () => {
    const query = buildRagQuery({
      ...baseInput,
      files: Array.from({ length: 15 }, (_, i) => ({ status: "M", path: `f${i}.ts` })),
    });
    expect(query).toContain("f0.ts");
    expect(query).toContain("(+3 файлов)");
  });
});

describe("renderReviewMarkdown", () => {
  it("рисует вердикт, секции и заглушку пустых рубрик", () => {
    const md = renderReviewMarkdown({
      source: "commit X",
      verdict: "changes_requested",
      summary: "Есть риск.",
      bugs: ["JSON.parse без try (routes/usage.ts:12)"],
      architecture: [],
      recommendations: [],
      sources: ["- [docs/STACK.md › §1] фрагмент"],
      model: "deepseek-chat",
      usage: fakeUsage(),
      latencyMs: 12_000,
      truncated: false,
      ragDegraded: false,
    });
    expect(md).toContain("🚫 changes_requested");
    expect(md).toContain("## Потенциальные баги");
    expect(md).toContain("нет находок");
    expect(md).toContain("docs/STACK.md");
  });
});

describe("createReviewService", () => {
  it("happy path: approved без RAG-находок", async () => {
    const env = {} as Parameters<typeof createReviewService>[0]["env"];
    const llm = fakeLlm([validReply]);
    const service = createReviewService({ env, llm, searcher: emptySearcher });
    const result = await service.review(baseInput);
    expect(result.verdict).toBe("approved");
    expect(result.sources).toEqual(["- (фрагменты не найдены)"]);
    expect(result.ragDegraded).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it("retry: невалидный JSON → второй вызов валиден", async () => {
    const env = {} as Parameters<typeof createReviewService>[0]["env"];
    const llm = fakeLlm(["oops не JSON", validReply]);
    const service = createReviewService({ env, llm, searcher: emptySearcher });
    const result = await service.review(baseInput);
    expect(result.verdict).toBe("approved");
    expect(llm.calls).toHaveLength(2);
  });

  it("RAG-сбой не валит ревью (degrade-not-crash)", async () => {
    const env = {} as Parameters<typeof createReviewService>[0]["env"];
    const throwing: ProjectSearcher = {
      search: async () => {
        throw new Error("index unavailable");
      },
    };
    const llm = fakeLlm([validReply]);
    const service = createReviewService({ env, llm, searcher: throwing });
    const result = await service.review(baseInput);
    expect(result.ragDegraded).toBe(true);
    expect(result.verdict).toBe("approved");
  });
});

describe("project corpus (day32: документация + код)", () => {
  it("корпус включает код сервера и клиента", async () => {
    const reader = createProjectCorpusReader();
    const sources = await reader.listSources();
    expect(sources).toContain("README.md");
    expect(sources).toContain("docs/STACK.md");
    expect(sources.some((s) => s.startsWith("server/src/"))).toBe(true);
    expect(sources.some((s) => s.startsWith("client/src/"))).toBe(true);
    expect(sources.some((s) => s.startsWith("shared/src/schemas/"))).toBe(true);
  });
});
