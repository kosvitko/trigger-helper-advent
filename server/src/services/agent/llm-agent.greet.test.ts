/**
 * UNIT — строка приветствия для системного промпта (llm-agent, 15.10):
 * время — клиентское (не сервера); только первое сообщение за сутки,
 * ночью — нейтральное приветствие.
 */
import { describe, expect, it } from "vitest";
import { greetSystemLine } from "./llm-agent.js";

describe("greetSystemLine — приветствие при первом сообщении за сутки", () => {
  it("firstOfDay=true: клиентское время + варианты по времени суток + «сразу к сути»", () => {
    const line = greetSystemLine({ localTime: "18:40", firstOfDay: true });
    expect(line).toContain("18:40");
    expect(line).toContain("Добрый вечер");
    expect(line).toContain("Здравствуйте");
    expect(line).toContain("сразу переходи к сути");
  });

  it("firstOfDay=false: пустая строка — в течение суток не здороваемся", () => {
    expect(greetSystemLine({ localTime: "18:40", firstOfDay: false })).toBe("");
  });
});
