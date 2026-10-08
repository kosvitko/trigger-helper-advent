/**
 * E2E 13 — close thread + undo (C+ CH-5b, поглотил close-session: сессий
 * больше нет — один уровень тредов): «✕ чат» закрывает ЛОКАЛЬНЫЙ тред
 * (без сети), активен сосед, тост «Чат «…» закрыт.»; «Вернуть»
 * восстанавливает запись и выбирает её; последний тред не закрывается —
 * кнопка disabled с подсказкой.
 */
import { test, expect } from "@playwright/test";
import { THREAD_BACK, THREAD_NECK, e2eBackThread, e2eNeckThread } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

test("✕ чат: локальное закрытие, активен сосед, «Вернуть» восстанавливает запись", async ({ page, context }) => {
  const api = await mockChat(context);
  await seedLocalData(context, { threads: [e2eBackThread(), e2eNeckThread()] }); // новейший — шея
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(THREAD_NECK);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1"); // лента треда «шея»

  await page.locator("#close-chat").click();

  // закрытие чисто локальное: ноль DELETE/POST — сеть не трогаем
  expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);

  // сосед стал активным: селектор без закрытого, лента — его диалог
  await expect(sel.locator("option")).toHaveCount(1);
  await expect(sel).toHaveValue(THREAD_BACK);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1");

  // тост undo с меткой закрытого треда
  const toast = page.locator(".undo");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Чат «Демо · шея» закрыт.");

  await toast.locator("button", { hasText: "Вернуть" }).click();

  // запись вернулась в коллекцию и снова активна, лента — его диалог
  await expect(sel.locator("option")).toHaveCount(2);
  await expect(sel).toHaveValue(THREAD_NECK);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  await expect(page.locator(".undo")).toHaveCount(0);
});

test("✕ чат disabled на последнем треде (замена close-session-гварда)", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(THREAD_NECK);
  const close = page.locator("#close-chat");
  await expect(close).toBeDisabled();
  await expect(close).toHaveAttribute(
    "title",
    "Нельзя закрыть последний чат — создайте новый",
  );
});
