/**
 * E2E 11 — reload (C+ CH-5b): ход идёт по SSE (мок-поток step+done);
 * перезагрузка страницы восстанавливает тред из localStorage (реальный
 * локальный персист, без мока messages), per-thread кэш трейса — из
 * sessionStorage (ход виден в трейсе без нового POST /api/chat).
 */
import { test, expect } from "@playwright/test";
import { activeThreadId, mockChat } from "./helpers";

test("reload: тред восстановлен из localStorage, SSE-ход, кэш трейса жив", async ({ page, context }) => {
  const api = await mockChat(context, { sse: true });
  await page.goto("/");
  const tid = await activeThreadId(page);

  // ход → SSE-мок: шаги + done; ход пишется в локальный тред
  await page.locator("#composer-input").fill("Болит шея справа, что делать?");
  await page.locator("#composer-send").click();
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:1"]`)).toBeVisible({ timeout: 10_000 });
  expect(api.chatCalls).toHaveLength(1);

  // write-behind: ждём debounce 500 мс (треды + кэш трейса)
  await page.waitForTimeout(900);

  // reload
  await page.reload();

  // тред восстановлен из localStorage (лента из записи th.threads.v1)
  await expect(page.locator(".msg.user", { hasText: "Болит шея справа" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:1"]`)).toBeVisible({ timeout: 10_000 });

  // кэш трейса per-thread: ход в трейсе без нового хода
  const turn = page.locator(`.trace .turn[data-turn-id="${tid}:1"]`);
  await expect(turn).toBeVisible({ timeout: 5_000 });
  expect(api.chatCalls).toHaveLength(1); // reload не дублирует
});
