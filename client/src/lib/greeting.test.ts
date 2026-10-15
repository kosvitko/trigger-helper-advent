/**
 * UNIT — флаг первого сообщения за местные сутки (greeting.ts): время
 * пользователя считает клиент, не сервер (Костя 15.10).
 */
import { describe, expect, it } from "vitest";
import { isFirstLocalDayTurn, localTimeHm } from "./greeting";

const now = new Date("2026-10-15T18:40:00");
const todayEarlier = new Date("2026-10-15T09:00:00");
const yesterday = new Date("2026-10-14T23:59:00");

describe("isFirstLocalDayTurn — первое сообщение за местные сутки", () => {
  it("лента пуста (новый участник) — первое", () => {
    expect(isFirstLocalDayTurn([], now)).toBe(true);
  });

  it("юзер писал сегодня — не первое", () => {
    expect(
      isFirstLocalDayTurn([{ role: "user", createdAt: todayEarlier.toISOString() }], now),
    ).toBe(false);
  });

  it("юзер писал вчера — снова первое (новые сутки)", () => {
    expect(
      isFirstLocalDayTurn([{ role: "user", createdAt: yesterday.toISOString() }], now),
    ).toBe(true);
  });

  it("сегодня только ассистент — первое", () => {
    expect(
      isFirstLocalDayTurn([{ role: "assistant", createdAt: todayEarlier.toISOString() }], now),
    ).toBe(true);
  });

  it("битая дата не считается сообщением сегодня", () => {
    expect(isFirstLocalDayTurn([{ role: "user", createdAt: "not-a-date" }], now)).toBe(true);
  });
});

describe("localTimeHm — местное время клиента", () => {
  it("«ЧЧ:ММ» без ведущих пропусков", () => {
    expect(localTimeHm(now)).toBe("18:40");
    expect(localTimeHm(new Date("2026-10-15T09:05:00"))).toBe("09:05");
  });
});
