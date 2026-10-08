/**
 * UNIT 3 — trace store (trace.svelte.ts): сборка хода из stateless-ответа
 * /api/chat (rag_ask-чип, LLM-нарратив, гейт dontKnow, railViolated, трим,
 * сжатие), смена скоупа, кэш th.trace.v1:<threadId> (debounce, кап 50,
 * drop-oldest), защищённое чтение битого/чужого кэша.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@trigger-helper/shared";
import { buildTurnFromChat, trace, type TurnBlock } from "./trace.svelte";
import {
  makeChatResponse,
  ragDontKnowPayload,
  ragOkPayload,
} from "../../test/fixtures";

beforeEach(() => {
  sessionStorage.clear();
  trace.setScope("sweep"); // гарантированно чистим предыдущий скоуп…
  trace.setScope(null); // …и возвращаемся «вне сессии»
});

describe("trace · buildTurnFromChat (C+ stateless /api/chat)", () => {
  it("turnId — клиентский параметр; rag_ask-шаг из trace.tool.calls.payload", () => {
    const res = makeChatResponse({ rag: ragOkPayload("как помочь при боли в шее?") });
    const t = buildTurnFromChat("вопрос", res, "th-1:3", 1200);
    expect(t.turnId).toBe("th-1:3");
    const rag = t.steps.find((s) => s.kind === "rag");
    expect(rag).toBeDefined();
    expect(rag!.data.rag?.question).toBe("как помочь при боли в шее?");
    expect(rag!.data.rag?.sourcesCount).toBe(3);
    expect(rag!.data.rag?.quotesCount).toBe(2);
    // модель агента умерла вместе с STATEFUL — модель из usage
    expect(t.model).toBe(res.usage.model);
    expect(t.latencyMs).toBe(1200); // клиентский замер (в ответе поля нет)
    // токены хода = LLM total + rag usage
    expect(t.tokens).toBe(res.usage.total_tokens + 640);
  });

  it("средние стадии пайплайна: подшаги rag + рельса-чек (Костя 041004)", () => {
    const res = makeChatResponse({ rag: ragOkPayload("q") });
    const t = buildTurnFromChat("в", res, "th:0");
    const titles = t.steps.map((s) => s.title);
    expect(titles).toContain("· рерайт запроса");
    expect(titles).toContain("· поиск по базе");
    expect(titles).toContain("· черновик по базе");
    expect(titles).toContain("· верификация цитат");
    expect(titles).toContain("Рельса-чек");
    const rw = t.steps.find((s) => s.title === "· рерайт запроса")!;
    expect(rw.data.variants).toHaveLength(2);
    expect(rw.data.sub).toContain("вариантов 2");
    const find = t.steps.find((s) => s.title === "· поиск по базе")!;
    expect(find.data.sub).toContain("пул 40");
    expect(find.data.sub).toContain("косинус top-1 0.713");
    const ver = t.steps.find((s) => s.title === "· верификация цитат")!;
    expect(ver.data.sub).toContain("дословно 2/2");
    expect(ver.data.sub).toContain("модель");
    const rail = t.steps.find((s) => s.title === "Рельса-чек")!;
    expect(rail.data.sub).toContain("✓");
  });

  it("contextTrimmed → шаг «Контекст обрезан» с числами (SEC-F4)", () => {
    const res = makeChatResponse({
      contextTrimmed: { droppedDialogue: 12, droppedSummaries: 1, charsBefore: 70000, charsAfter: 63000 },
    });
    const t = buildTurnFromChat("в", res, "th:0");
    const trim = t.steps.find((s) => s.title === "Контекст обрезан");
    expect(trim).toBeDefined();
    expect(trim!.data.sub).toContain("−12 сообщ.");
    expect(trim!.data.sub).toContain("−1 сводок");
    expect(trim!.data.sub).toContain("70000 → 63000");
  });

  it("compress → лёгкий шаг сжатия (usage в инлайн-сжатии нет — карточки тоже)", () => {
    const res = makeChatResponse({
      compress: { summary: "сводка", keptTail: [{ role: "user", content: "q" }] },
    });
    const t = buildTurnFromChat("в", res, "th:0");
    const c = t.steps.find((s) => s.kind === "compress");
    expect(c).toBeDefined();
    expect(c!.data.sub).toContain("хвост 1");
    expect(c!.data.compress).toBeUndefined(); // структурной карточки нет — без usage
  });

  it("dontKnow-гейт и railViolated — те же семантики, что в run-ходе", () => {
    const dk = buildTurnFromChat("в", makeChatResponse({ rag: ragDontKnowPayload("оффтоп?") }), "th:0");
    const gate = dk.steps.find((s) => s.kind === "gate");
    expect(gate).toBeDefined();
    expect(gate!.data.sub).toContain("порога 0.8375");
    expect(buildTurnFromChat("в", makeChatResponse({ railViolated: true }), "th:0").railViolated).toBe(true);
    expect(buildTurnFromChat("в", makeChatResponse({ railViolated: false }), "th:0").railViolated).toBe(false);
  });

  it("addTurnFromChat заменяет pending-ход реальным и кэшируется", () => {
    vi.useFakeTimers();
    try {
      trace.setScope("th-chat");
      trace.beginPending("вопрос");
      expect(trace.turns.has("__pending__")).toBe(true);
      trace.addTurnFromChat("вопрос", makeChatResponse({ reply: "ок" }), "th-chat:0", 500);
      expect(trace.turns.has("__pending__")).toBe(false);
      expect(trace.turnBy("th-chat:0")?.userText).toBe("вопрос");
      vi.advanceTimersByTime(600);
      const saved = JSON.parse(sessionStorage.getItem("th.trace.v1:th-chat")!) as { turns: TurnBlock[] };
      expect(saved.turns.map((t) => t.turnId)).toEqual(["th-chat:0"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("trace · mergeThread — скелеты ходов из истории (QA 041003 F1)", () => {
  const mkUsage = (total: number) => ({
    model: "deepseek-flash",
    prompt_tokens: total - 100,
    completion_tokens: 100,
    total_tokens: total,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: total - 100,
    estimated_cost_usd: 0.001,
    estimated_cost_rub: 0.1,
  });
  const threadMsgs: AgentMessage[] = [
    { id: "u1", role: "user", content: "болит шея", createdAt: "2026-10-04T00:00:00Z" },
    {
      id: "a1", role: "assistant", content: "ответ 1", createdAt: "2026-10-04T00:00:05Z",
      model: "deepseek-flash", latency_ms: 4200, usage: mkUsage(900), cost_rub: 0.12,
    },
    { id: "u2", role: "user", content: "а плечо?", createdAt: "2026-10-04T00:01:00Z" },
    {
      id: "a2", role: "assistant", content: "ответ 2", createdAt: "2026-10-04T00:01:07Z",
      model: "deepseek-flash", latency_ms: 7000, usage: mkUsage(1500), cost_rub: 0.2,
    },
  ];

  it("свежая вкладка: скелеты ходов из сообщений, существующие ходы не тронуты", () => {
    trace.setScope("agent-x");
    trace.mergeThread(threadMsgs);
    expect(trace.turns.size).toBe(2);
    const sk = trace.turnBy("a1")!;
    expect(sk.restored).toBe(true);
    expect(sk.userText).toBe("болит шея");
    expect(sk.model).toBe("deepseek-flash");
    expect(sk.tokens).toBe(900);
    expect(sk.costRub).toBe(0.12);
    expect(sk.steps).toEqual([]);
    // живой ход с тем же id не перезаписывается скелетом
    trace.addTurnFromChat("болит шея", makeChatResponse({ rag: ragOkPayload("q") }), "a1");
    trace.mergeThread(threadMsgs);
    expect(trace.turnBy("a1")!.restored ?? false).toBe(false);
  });

  it("рельса в totals считается только по живым ходам", () => {
    trace.setScope("agent-y");
    trace.mergeThread(threadMsgs); // 2 скелета — рельса неизвестна
    let t = trace.totals();
    expect(t.turns).toBe(2);
    expect(t.railTotal).toBe(0);
    trace.addTurnFromChat("вопрос", makeChatResponse({ rag: ragOkPayload("q") }), "live1");
    t = trace.totals();
    expect(t.railTotal).toBe(1);
    expect(t.railOk).toBe(1);
  });

  it("lastLiveModel — фактическая модель последнего живого хода (F3)", () => {
    trace.setScope("agent-z");
    expect(trace.lastLiveModel()).toBeNull();
    trace.mergeThread(threadMsgs);
    expect(trace.lastLiveModel()).toBeNull(); // только скелеты
    const live = makeChatResponse({ rag: ragOkPayload("q") });
    trace.addTurnFromChat("в", live, "live");
    expect(trace.lastLiveModel()).toBe(live.usage.model);
  });

  it("restored-флаг переживает кэш (схема пропускает)", () => {
    vi.useFakeTimers();
    trace.setScope("agent-c");
    trace.mergeThread(threadMsgs);
    vi.advanceTimersByTime(600);
    const raw = sessionStorage.getItem("th.trace.v1:agent-c");
    expect(raw).toContain('"restored":true');
    // смена скоупа и возврат — восстановление из кэша не роняет safeParse
    trace.setScope(null);
    trace.setScope("agent-c");
    expect(trace.turnBy("a1")?.restored).toBe(true);
    vi.useRealTimers();
  });
});

describe("trace · скоуп агента и кэш sessionStorage", () => {
  it("setScope(agentId) сбрасывает ходы (изоляция сессий)", () => {
    trace.setScope("agent-a");
    trace.addTurnFromChat("q", makeChatResponse({}), "m-a1");
    expect(trace.turns.size).toBe(1);
    trace.setScope("agent-b");
    expect(trace.turns.size).toBe(0);
    expect(trace.turnBy("m-a1")).toBeNull();
  });

  it("ключ кэша th.trace.v1:<agentId>, запись write-behind (debounce 500 мс)", () => {
    vi.useFakeTimers();
    try {
      trace.setScope("agent-cache");
      trace.addTurnFromChat("q", makeChatResponse({}), "m-c1");
      expect(sessionStorage.getItem("th.trace.v1:agent-cache")).toBeNull(); // ещё не записан
      vi.advanceTimersByTime(600);
      const raw = sessionStorage.getItem("th.trace.v1:agent-cache");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as { version: number; turns: TurnBlock[] };
      expect(parsed.version).toBe(1);
      expect(parsed.turns.map((t) => t.turnId)).toEqual(["m-c1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("кап 50 ходов, drop-oldest (и в памяти, и в кэше)", () => {
    vi.useFakeTimers();
    try {
      trace.setScope("agent-cap");
      for (let i = 0; i < 52; i += 1) {
        trace.addTurnFromChat(`q${i}`, makeChatResponse({}), `m-${i}`);
      }
      vi.advanceTimersByTime(600);
      expect(trace.turns.size).toBe(50);
      expect(trace.ordered[0].turnId).toBe("m-2"); // два старейших выброшены
      expect(trace.ordered.at(-1)?.turnId).toBe("m-51");
      const saved = JSON.parse(sessionStorage.getItem("th.trace.v1:agent-cap")!) as {
        turns: TurnBlock[];
      };
      expect(saved.turns).toHaveLength(50);
      expect(saved.turns[0].turnId).toBe("m-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("битый JSON в кэше → чистый старт без throw", () => {
    sessionStorage.setItem("th.trace.v1:bad-json", "{не-json вообще");
    expect(() => trace.setScope("bad-json")).not.toThrow();
    expect(trace.turns.size).toBe(0);
  });

  it("несовпадение версии кэша → чистый старт без throw", () => {
    sessionStorage.setItem(
      "th.trace.v1:bad-ver",
      JSON.stringify({ version: 99, turns: [{ turnId: "x", steps: [] }] }),
    );
    expect(() => trace.setScope("bad-ver")).not.toThrow();
    expect(trace.turns.size).toBe(0);
  });

  it("валидный кэш восстанавливается при setScope", () => {
    const turn = buildTurnFromChat("q", makeChatResponse({ rag: ragOkPayload("q") }), "m-load");
    sessionStorage.setItem("th.trace.v1:good", JSON.stringify({ version: 1, turns: [turn] }));
    trace.setScope("good");
    expect(trace.turnBy("m-load")).not.toBeNull();
    expect(trace.ordered).toHaveLength(1);
  });
});
