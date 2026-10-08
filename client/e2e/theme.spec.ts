/**
 * E2E — тема оформления (051005): ручное закрепление в Настройках → Интерфейс
 * (системная/светлая/тёмная). Регресс фикса волны дня 25: закрепление
 * переживает reload (main.ts применяет ДО монтирования — без мигания),
 * «Системная» снимает закрепление и чистит th.theme.
 */
import { test, expect } from "@playwright/test";
import { e2eNeckThread } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

test("тема: закрепление тёмной переживает reload, системная чистит выбор", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await page.goto("/");
  await expect(page.locator(".msg.user").first()).toContainText("a-q1"); // boot готов (сеяный тред)

  // Настройки → Интерфейс: три опции, по умолчанию системная
  await page.getByRole("button", { name: "⚙ Настройки" }).click();
  await page.locator(".settings .nav-item", { hasText: "Интерфейс" }).click();
  const themeSelect = page.locator(".settings select");
  await expect(themeSelect).toHaveValue("");
  for (const label of ["Системная", "Светлая", "Тёмная"]) {
    await expect(themeSelect.locator("option", { hasText: label })).toHaveCount(1);
  }

  // Тёмная: data-theme на <html> + th.theme в localStorage
  await themeSelect.selectOption("dark");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("th.theme"))).toBe("dark");

  // Переживает reload: закрепление применяется в main.ts до монтирования
  await page.reload();
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.getByRole("button", { name: "⚙ Настройки" }).click();
  await page.locator(".settings .nav-item", { hasText: "Интерфейс" }).click();
  await expect(page.locator(".settings select")).toHaveValue("dark");

  // Системная: закрепление снято — атрибут и ключ убраны
  await page.locator(".settings select").selectOption("");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("th.theme"))).toBeNull();
});
