/**
 * E2E 12 — composer guard (баг 3): без активной сессии (пустой список
 * инстансов) кнопка «Отправить» задизейблена + подсказка; ввод текста не
 * отправляет ничего (ноль POST /api/agent/run).
 */
import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test("без сессий: send задизейблен, ноль POST", async ({ page, context }) => {
  const api = await mockApi(context, {
    instances: { instances: [], caps: { maxInstances: 8, maxAgentsPerInstance: 16 } },
    createInstance: { status: 429, body: { error: "Лимит инстансов" } }, // бут-ретрай тоже падает
  });
  await page.goto("/");

  // кнопка disabled
  const send = page.locator("#composer-send");
  await expect(send).toBeDisabled();

  // пустое состояние диалога остаётся
  await expect(page.locator(".feed .empty")).toContainText("Опишите, что болит");

  // попытка ввода и Enter ничего не шлёт
  await page.locator("#composer-input").fill("тест");
  await page.locator("#composer-input").press("Enter").catch(() => {});
  await page.waitForTimeout(300);
  expect(api.calls.filter((c) => c.path === "/api/agent/run")).toHaveLength(0);
});
