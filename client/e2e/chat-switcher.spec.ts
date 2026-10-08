/**
 * E2E — селектор чатов в шапке (C+ CH-5b: один уровень — локальные треды,
 * сессий нет): boot активен новейший тред; переключение тредов внутри списка
 * и возврат — лента без утечки чужих диалогов.
 */
import { test, expect } from "@playwright/test";
import { THREAD_BACK, THREAD_CARE, THREAD_NECK, e2eBackThread, e2eCareThread, e2eNeckThread } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

test("селектор: boot активен новейший тред, список с заголовками", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eCareThread(), e2eBackThread(), e2eNeckThread()] });
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel.locator("option")).toHaveCount(3);
  await expect(sel).toHaveValue(THREAD_NECK); // boot: новейший по updatedAt
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("Демо · шея");
  await expect(sel.locator("option")).toContainText(["Демо · шея", "Демо · поясница", "Демо · забота"]);
});

test("селектор: переключение тредов без утечки чужих сообщений", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eCareThread(), e2eBackThread(), e2eNeckThread()] });
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(THREAD_NECK);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");

  // переключение на Care-тред: лента — только его диалог
  await sel.selectOption(THREAD_CARE);
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("Демо · забота");
  await expect(page.locator(".msg.user").first()).toContainText("c-q1");
  await expect(page.locator(".msg", { hasText: "a-q1" })).toHaveCount(0);

  // переход на третий тред и обратно — без утечки care → rag
  await sel.selectOption(THREAD_BACK);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1");
  await sel.selectOption(THREAD_NECK);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  await expect(page.locator(".msg", { hasText: "c-q1" })).toHaveCount(0);
});
