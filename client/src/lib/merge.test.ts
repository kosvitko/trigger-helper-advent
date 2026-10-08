/**
 * UNIT — merge memoryDelta на клиенте (C+ CH-5b, Q-3): дословный перенос
 * серверных алгоритмов day11 (факты: Jaccard 0.7, tombstones, keepLayer)
 * и day25 (память задачи: дедуп-слияние списков) + триггер сжатия day09.
 */
import { describe, expect, it } from "vitest";
import {
  mergeChatTaskDelta,
  mergeFactDelta,
  shouldCompressChatTail,
  type FactRow,
} from "@trigger-helper/shared";

const fact = (over: Partial<FactRow> = {}): FactRow => ({
  id: "f1",
  text: "боль в шее после работы",
  layer: "working",
  suggestedLayer: "working",
  source: "classify",
  overridden: false,
  updatedAt: "2026-10-05T00:00:00Z",
  ...over,
});

const NOW = () => "2026-10-05T12:00:00Z";

describe("mergeFactDelta (день 11)", () => {
  it("новый факт добавляется; парафраз-перестановка (Jaccard = 1) обновляет, не дублирует", () => {
    const prev = [fact()];
    const r1 = mergeFactDelta(prev, [], { historySeq: 0 }, NOW);
    expect(r1.facts).toHaveLength(1);

    // добавление слова — уже другой токен-сет (Jaccard < 0.7) → новая запись
    const rWord = mergeFactDelta(
      prev,
      [{ text: "боль в шее после работы за ноутбуком", suggestedLayer: "long" }],
      { historySeq: 0 },
      NOW,
    );
    expect(rWord.facts).toHaveLength(2);

    // перестановка тех же слов — тот же токен-сет (Jaccard = 1) → апдейт
    const r = mergeFactDelta(
      prev,
      [{ text: "после работы боль в шее", suggestedLayer: "long" }],
      { historySeq: 0 },
      NOW,
    );
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.text).toBe("после работы боль в шее");
    expect(r.facts[0]!.layer).toBe("long");
  });

  it("ручной перенос слоя сохраняется (keepLayer), suggested не затирает", () => {
    const prev = [fact({ layer: "long", suggestedLayer: "working", overridden: true })];
    const r = mergeFactDelta(
      prev,
      [{ text: "боль в шее после работы", suggestedLayer: "short" }],
      { historySeq: 0 },
      NOW,
    );
    expect(r.facts[0]!.layer).toBe("long");
    expect(r.facts[0]!.suggestedLayer).toBe("short");
  });

  it("tombstone подавляет добавление; протухший (untilSeq ≤ historySeq) — нет", () => {
    const deleted = [{ norm: "не наклонять шею", untilSeq: 10 }];
    const item = { text: "не наклонять шею", suggestedLayer: "short" as const };
    const fresh = mergeFactDelta([], [item], { historySeq: 5, deleted }, NOW);
    expect(fresh.facts).toHaveLength(0); // подавлен
    const expired = mergeFactDelta([], [item], { historySeq: 10, deleted }, NOW);
    expect(expired.facts).toHaveLength(1); // tombstone истёк
    expect(expired.deleted).toHaveLength(0); // истёкший не возвращается
  });
});

describe("mergeChatTaskDelta (день 25)", () => {
  it("goal обновляется, clarified дедуп-мержится с капом 8", () => {
    const prev = {
      goal: "понять причину боли",
      clarified: ["болит сбоку шеи"],
      constraints_terms: [],
    };
    const next = mergeChatTaskDelta(prev, {
      goal: "понять причину боли и убрать",
      clarified: ["болит сбоку шеи", "усиливается к вечеру"],
      constraints_terms: ["без резких движений"],
    });
    expect(next.goal).toBe("понять причину боли и убрать");
    expect(next.clarified).toEqual(["болит сбоку шеи", "усиливается к вечеру"]);
    expect(next.constraints_terms).toEqual(["без резких движений"]);
  });

  it("парафраз-перестановка уточнения не дублируется (3-символьные префиксы)", () => {
    const prev = { goal: "", clarified: ["болит сбоку шеи"], constraints_terms: [] };
    // тот же токен-сет в другом порядке → Jaccard = 1 → дедуп
    const next = mergeChatTaskDelta(prev, {
      clarified: ["шеи сбоку болит"],
    });
    expect(next.clarified).toHaveLength(1);
    // добавленное слово — другой сет → новая запись
    const grown = mergeChatTaskDelta(prev, {
      clarified: ["болит сбоку шеи после сна"],
    });
    expect(grown.clarified).toHaveLength(2);
  });
});

describe("shouldCompressChatTail (день 09 → Q-2)", () => {
  it("триггер: диалог минус keepLast ≥ every", () => {
    expect(shouldCompressChatTail(13, 10)).toBe(false); // 13-4=9 < 10
    expect(shouldCompressChatTail(14, 10)).toBe(true); // 14-4=10 ≥ 10
    expect(shouldCompressChatTail(99, 0)).toBe(false); // выключено
    expect(shouldCompressChatTail(99, 10, 0)).toBe(true); // keepLast=0
  });
});
