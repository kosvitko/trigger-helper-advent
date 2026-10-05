/**
 * UNIT — постпроцессинг ответа (markdown.ts):
 * вырезание секции «Источники» во всех формах записи (грабля 031003:
 * кириллица не матчилась \w — «Источники:» оставался в конце ответа),
 * вырезание инлайн-меток, орфанных буллетов и рендер маркдауна.
 */
import { describe, expect, it } from "vitest";
import { renderReply, stripSourceLabels } from "./markdown";

describe("stripSourceLabels — секция источников", () => {
  it("«Источники:» + список меток — секция уходит целиком (репорт 031003)", () => {
    const text = [
      "Сделайте паузу и разомните плечи.",
      "",
      "Источники:",
      "- [Атлас тела › Трапеции]",
      "- [Мышцы спины › Разминка]",
    ].join("\n");
    expect(stripSourceLabels(text)).toBe("Сделайте паузу и разомните плечи.");
  });

  it("«## Источники» — заголовочный вариант", () => {
    const text = "Текст ответа.\n\n## Источники\n- [А › Б]";
    expect(stripSourceLabels(text)).toBe("Текст ответа.");
  });

  it("«**Источники:**» — жирный вариант", () => {
    const text = "Текст ответа.\n\n**Источники:**\n- [А › Б] · [В › Г]";
    expect(stripSourceLabels(text)).toBe("Текст ответа.");
  });

  it("метки в той же строке после заголовка — строка уходит", () => {
    const text = "Текст ответа.\n\nИсточники: [А › Б], [В › Г]";
    expect(stripSourceLabels(text)).toBe("Текст ответа.");
  });

  it("секция после разделителя «---» — тело живо, разделитель уходит", () => {
    const text = "Первый абзац.\n\n---\n\nИсточники:\n- [А › Б]";
    expect(stripSourceLabels(text)).toBe("Первый абзац.");
  });

  it("dontKnow-ответ без секции — текст не тронут", () => {
    const text = "В базе нет релевантного материала по этому вопросу.";
    expect(stripSourceLabels(text)).toBe(text);
  });
});

describe("stripSourceLabels — инлайн-метки", () => {
  it("метка внутри предложения вырезается, текст остаётся", () => {
    expect(stripSourceLabels("Разминка [Атлас › Трапеции] каждые 40 минут."))
      .toBe("Разминка каждые 40 минут.");
  });

  it("слово «источники» внутри предложения не вырезается", () => {
    const text = "Проверьте источники перед выполнением.";
    expect(stripSourceLabels(text)).toBe(text);
  });
});

describe("renderReply — сквозной пайплайн", () => {
  it("нет «Источники» и меток; жирный рендерится <strong>", () => {
    const text = [
      "**Шаг 1.** Разминка.",
      "",
      "Источники:",
      "- [Атлас тела › Трапеции]",
    ].join("\n");
    const html = renderReply(text);
    expect(html).toContain("<strong>Шаг 1.</strong>");
    expect(html).not.toContain("Источники");
    expect(html).not.toContain("[Атлас");
  });
});
