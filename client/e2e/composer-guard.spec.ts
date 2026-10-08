/**
 * E2E 12 — composer guard (C+ CH-5b): boot без активного треда невозможен
 * (ensureActive создаёт локальный RAG-чат) — старый гвард «нет сессии»
 * недостижим. Намерение переносится на busy-гвард композера: во время хода
 * кнопка «Отправить» задизейблена («Отправляем…»), повторные клики и Enter
 * не плодят POST /api/chat.
 */
import { test, expect } from "@playwright/test";
import { activeThreadId, mockChat } from "./helpers";

test("typing: send заблокирован, двойной клик и Enter не дублируют POST", async ({ page, context }) => {
  const api = await mockChat(context, { chatDelayMs: 600 });
  await page.goto("/");
  const tid = await activeThreadId(page);

  const send = page.locator("#composer-send");
  await page.locator("#composer-input").fill("Болит шея справа, что делать?");
  await send.click();

  // во время хода: кнопка disabled с текстом «Отправляем…»
  await expect(send).toBeDisabled();
  await expect(send).toHaveText("Отправляем…");
  await expect(page.locator(".feed .typing")).toBeVisible();

  // повторный клик и Enter игнорируются (busy-guard в Composer/DialogStore)
  await send.click({ timeout: 1_000 }).catch(() => {});
  await page.locator("#composer-input").press("Enter").catch(() => {});

  const assistant = page.locator(`.msg.bot[data-turn-id="${tid}:1"]`);
  await expect(assistant).toBeVisible({ timeout: 10_000 });
  expect(api.chatCalls).toHaveLength(1); // ровно один POST /api/chat

  // ход завершён: кнопка снова доступна
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("Отправить");
  await expect(page.locator(".feed .typing")).toHaveCount(0);
});
