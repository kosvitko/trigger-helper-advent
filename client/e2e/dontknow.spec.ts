/**
 * E2E 9 — dontKnow-ход (мок): честный ответ без выдумывания; гейт-шаг в
 * трейсе; НЕТ положительного SourcesChip (источников не found).
 */
import { test, expect } from "@playwright/test";
import { e2eRunDontKnow, RUN_DONTKNOW_ID } from "./fixtures";
import { mockApi } from "./helpers";

test("dontKnow: честный ответ, гейт-шаг, без чипа источников", async ({ page, context }) => {
  const api = await mockApi(context, { emptyThreads: true });
  api.setRun(() => e2eRunDontKnow("как продлить визу"));
  await page.goto("/");

  await page.locator("#composer-input").fill("как продлить визу в Таиланде?");
  await page.locator("#composer-send").click();

  const bubble = page.locator(`.msg.bot[data-turn-id="${RUN_DONTKNOW_ID}"]`);
  await expect(bubble).toBeVisible({ timeout: 10_000 });
  await expect(bubble).toContainText("в базе нет релевантного");

  // чип источников НЕ показан (dontKnow — нечего показывать)
  await expect(page.locator(".src-chip")).toHaveCount(0);

  // трейс: ход с гейт-шагом «не знаю» (авто-раскрытие нового хода; фолбэк)
  const turn = page.locator(`.trace .turn[data-turn-id="${RUN_DONTKNOW_ID}"]`);
  await expect(turn).toBeVisible();
  const gateSel = turn.locator(".step-wrap", { hasText: "не знаю" }).or(turn.locator(".step-wrap", { hasText: "Гейт" }));
  if (!(await gateSel.isVisible().catch(() => false))) {
    await turn.locator(".tsummary").click();
  }
  await expect(gateSel).toBeVisible();
});
