/**
 * E2E 10 — thread switch (баг 2, строгий; C+ CH-5b: сессии → локальные
 * треды): два треда с разными диалогами; переключение показывает ТОЛЬКО
 * диалог этого треда — без утечки сообщений предыдущего; переключение
 * обратно — тоже чисто.
 */
import { test, expect } from "@playwright/test";
import { THREAD_BACK, THREAD_NECK, e2eBackThread, e2eNeckThread } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

test("переключение тредов: лента без утечки чужих сообщений", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eBackThread(), e2eNeckThread()] });
  await page.goto("/");

  // дефолт: новейший тред «шея» — лента = его диалог (2 сообщения)
  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(THREAD_NECK);
  await expect(page.locator(".msg")).toHaveCount(2);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");

  // переключение на «поясницу»: лента = только его диалог
  await sel.selectOption(THREAD_BACK);
  await expect(page.locator(".msg")).toHaveCount(2);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1");
  await expect(page.locator(".msg", { hasText: "a-q1" })).toHaveCount(0); // никакой утечки шея→поясница

  // обратно на «шею»: только его диалог
  await sel.selectOption(THREAD_NECK);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  await expect(page.locator(".msg", { hasText: "b-q1" })).toHaveCount(0); // и поясница→шея
});
