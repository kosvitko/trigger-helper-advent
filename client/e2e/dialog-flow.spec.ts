/**
 * E2E 8 — dialog flow (мок run-ответа): ввод → один клик → ровно один
 * user-бабл; typing-индикатор; ассистент-бабл .msg.bot[data-turn-id];
 * SourcesChip «Источники N · цитаты M/M ✓» свёрнут → раскрытие карточек
 * цитат с [source › section]; TurnBlock в трейсе с заголовком хода
 * (модель/латентность/токены/₽).
 */
import { test, expect } from "@playwright/test";
import { e2eRunRag, RUN_ANS_ID } from "./fixtures";
import { mockApi } from "./helpers";

test("диалог: send → бабл + SourcesChip + трейс-ход", async ({ page, context }) => {
  const api = await mockApi(context, { emptyThreads: true, runDelayMs: 400 });
  await page.goto("/");

  // typing-индикатор появляется во время run (runDelayMs=400 — окно)
  await page.locator("#composer-input").fill("Болит шея справа, что делать?");
  await page.locator("#composer-send").click();
  await expect(page.locator(".feed .typing")).toBeVisible();

  // ровно один POST /api/agent/run (двойной клик не дублирует)
  await page.locator("#composer-send").click().catch(() => {}); // занят — игнор
  const assistant = page.locator(`.msg.bot[data-turn-id="${RUN_ANS_ID}"]`);
  await expect(assistant).toBeVisible({ timeout: 10_000 });
  expect(api.calls.filter((c) => c.path === "/api/agent/run")).toHaveLength(1);

  // ровно один user-бабл (свой, local-*)
  await expect(page.locator(".msg.user")).toHaveCount(1);
  // typing исчез
  await expect(page.locator(".feed .typing")).toHaveCount(0);

  // SourcesChip: «Источники N» (+ ✓ если все цитаты верифицированы)
  const chip = page.locator(".src-chip");
  await expect(chip).toContainText("Источники");
  await expect(chip).toContainText("2/2");
  await expect(page.locator(".qcard")).toHaveCount(0); // свёрнуто

  // раскрытие: карточки цитат с [source › section]
  await chip.click();
  const cards = page.locator(".qcard");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator(".qlabel")).toContainText("[travell-guide › Шея]");
  await expect(cards.first().locator(".qlabel.ok")).toBeVisible(); // верифицирована

  // трейс: TurnBlock с тем же data-turn-id и заголовком хода
  const turn = page.locator(`.trace .turn[data-turn-id="${RUN_ANS_ID}"]`);
  await expect(turn).toBeVisible();
  await expect(turn.locator(".tno")).toContainText("Ход 1");
  await expect(turn.locator(".tm")).toContainText("deepseek-chat");
  await expect(turn.locator(".tm")).toContainText("2.1k");
  // шаги: авто-раскрытие нового хода (UX-фикс 03.10) — шаги уже видны
  // (если не видно — клик по .tsummary раскроет)
  const stepSel = turn.locator(".step-wrap .what", { hasText: "rag_ask" });
  if (!(await stepSel.isVisible().catch(() => false))) {
    await turn.locator(".tsummary").click(); // фолбэк: ручное раскрытие
  }
  await expect(stepSel).toBeVisible();
});
