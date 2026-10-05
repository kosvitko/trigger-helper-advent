/**
 * UNIT 3 — trace store (trace.svelte.ts):
 * сборка хода (turnId=message.id, rag_ask-чип, LLM-нарратив, гейт dontKnow,
 * railViolated), смена скоупа, кэш th.trace.v1:<agentId> (debounce, кап 50,
 * drop-oldest), защищённое чтение битого/чужого кэша.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@trigger-helper/shared";
import {
  buildTurnFromRun,
  trace,
  type TurnBlock,
} from "./trace.svelte";
import {
  makeRunResponse,
  ragDontKnowPayload,
  ragOkPayload,
} from "../../test/fixtures";

beforeEach(() => {
  sessionStorage.clear();
  trace.setScope("sweep"); // гарантированно чистим предыдущий скоуп…
  trace.setScope(null); // …и возвращаемся «вне сессии»
});

describe("trace · buildTurnFromRun", () => {
  it("turnId = id ассистент-сообщения; rag_ask-шаг несёт вопрос/источники/цитаты/dontKnow", () => {
    const res = makeRunResponse({ messageId: "msg-r1", rag: ragOkPayload("как помочь при боли в шее?") });
    const t = buildTurnFromRun("вопрос пользователя", res);
    expect(t.turnId).toBe("msg-r1");
    const rag = t.steps.find((s) => s.kind === "rag");
    expect(rag).toBeDefined();
    expect(rag!.title).toBe("rag_ask");
    expect(rag!.data.rag?.question).toBe("как помочь при боли в шее?");
    expect(rag!.data.rag?.sourcesCount).toBe(3);
    expect(rag!.data.rag?.quotesCount).toBe(2);
    expect(rag!.data.rag?.dontKnow).toBe(false);
    expect(rag!.data.rag?.topCosine).toBeCloseTo(0.713, 3);
    expect(rag!.data.rag?.threshold).toBe(0.8375);
  });

  it("LLM-нарратив — отдельная строка с usage-цифрами", () => {
    const res = makeRunResponse({ messageId: "m", rag: ragOkPayload("q") });
    const t = buildTurnFromRun("в", res);
    const llm = t.steps.find((s) => s.title === "Нарратив");
    expect(llm).toBeDefined();
    expect(llm!.data.cost).toBe("360"); // fmtTok(completion_tokens)
    // токены хода = LLM total + rag usage
    expect(t.tokens).toBe(res.usage.total_tokens + 640);
  });

  it("средние стадии пайплайна: подшаги rag + рельса-чек (Костя 041004)", () => {
    const res = makeRunResponse({ messageId: "m-sub", rag: ragOkPayload("q") });
    const t = buildTurnFromRun("в", res);
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

  it("dontKnow-ход: гейт «не знаю» присутствует, позитивных источников нет", () => {
    const res = makeRunResponse({ messageId: "m-dk", rag: ragDontKnowPayload("сколько весит лунный грунт?") });
    const t = buildTurnFromRun("в", res);
    const gate = t.steps.find((s) => s.kind === "gate");
    expect(gate).toBeDefined();
    expect(gate!.title).toContain("не знаю");
    expect(gate!.data.sub).toContain("порога 0.8375"); // QA 041003: порог — числом
    const rag = t.steps.find((s) => s.kind === "rag")!;
    expect(rag.data.rag?.dontKnow).toBe(true);
    expect(rag.data.rag?.sourcesCount).toBe(0);
  });

  it("railViolated отражается флагом хода", () => {
    const ok = makeRunResponse({ messageId: "m", rag: ragOkPayload("q"), railViolated: false });
    expect(buildTurnFromRun("в", ok).railViolated).toBe(false);
    const bad = makeRunResponse({ messageId: "m", rag: ragOkPayload("q"), railViolated: true });
    expect(buildTurnFromRun("в", bad).railViolated).toBe(true);
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
    trace.addTurnFromRun("болит шея", makeRunResponse({ messageId: "a1", rag: ragOkPayload("q") }));
    trace.mergeThread(threadMsgs);
    expect(trace.turnBy("a1")!.restored ?? false).toBe(false);
  });

  it("рельса в totals считается только по живым ходам", () => {
    trace.setScope("agent-y");
    trace.mergeThread(threadMsgs); // 2 скелета — рельса неизвестна
    let t = trace.totals();
    expect(t.turns).toBe(2);
    expect(t.railTotal).toBe(0);
    trace.addTurnFromRun("вопрос", makeRunResponse({ messageId: "live1", rag: ragOkPayload("q") }));
    t = trace.totals();
    expect(t.railTotal).toBe(1);
    expect(t.railOk).toBe(1);
  });

  it("lastLiveModel — фактическая модель последнего живого хода (F3)", () => {
    trace.setScope("agent-z");
    expect(trace.lastLiveModel()).toBeNull();
    trace.mergeThread(threadMsgs);
    expect(trace.lastLiveModel()).toBeNull(); // только скелеты
    trace.addTurnFromRun("в", makeRunResponse({ messageId: "live", rag: ragOkPayload("q") }));
    expect(trace.lastLiveModel()).toBe(makeRunResponse({ messageId: "live", rag: ragOkPayload("q") }).agent.model);
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
    trace.addTurnFromRun("q", makeRunResponse({ messageId: "m-a1" }));
    expect(trace.turns.size).toBe(1);
    trace.setScope("agent-b");
    expect(trace.turns.size).toBe(0);
    expect(trace.turnBy("m-a1")).toBeNull();
  });

  it("ключ кэша th.trace.v1:<agentId>, запись write-behind (debounce 500 мс)", () => {
    vi.useFakeTimers();
    try {
      trace.setScope("agent-cache");
      trace.addTurnFromRun("q", makeRunResponse({ messageId: "m-c1" }));
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
        trace.addTurnFromRun(`q${i}`, makeRunResponse({ messageId: `m-${i}` }));
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
    const turn = buildTurnFromRun("q", makeRunResponse({ messageId: "m-load", rag: ragOkPayload("q") }));
    sessionStorage.setItem("th.trace.v1:good", JSON.stringify({ version: 1, turns: [turn] }));
    trace.setScope("good");
    expect(trace.turnBy("m-load")).not.toBeNull();
    expect(trace.ordered).toHaveLength(1);
  });
});
