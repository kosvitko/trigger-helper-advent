/**
 * E2E 6 — boot (C+ CH-5b): чистый браузер → шелл рендерится (бренд, сегмент
 * «Диалог | Оба | Трейс»), пустое состояние диалога; локальный пустой rag_chat-
 * тред создаётся на устройстве без сети (единственный запрос — справочник
 * моделей), селектор показывает его, th.active.v1 зафиксирован.
 */
import { test, expect } from "@playwright/test";
import { mockChat } from "./helpers";

test("boot: бренд, сегмент, empty-state, первый локальный RAG-чат без сети", async ({ page, context }) => {
  const api = await mockChat(context);
  await page.goto("/");

  // бренд в шапке
  await expect(page.locator(".brand")).toContainText("Trigger Helper");

  // сегмент-контрол с тремя подписями
  await expect(page.locator(".seg button")).toHaveText(["Диалог", "Оба", "Трейс"]);

  // пустое состояние продуктовым голосом (D-3)
  await expect(page.locator(".feed .empty")).toContainText("Опишите, что болит");

  // селектор чатов: один локальный тред (создан ensureActive), активен
  const sel = page.locator("select.session");
  await expect(sel.locator("option")).toHaveCount(1);
  await expect(sel.locator("option")).toContainText("RAG-чат");
  const tid = await sel.inputValue();
  expect(tid).not.toBe("");
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("RAG-чат");

  // тред персистится на устройстве: запись rag_chat с пустым диалогом + актив
  await page.waitForTimeout(800); // write-behind debounce 500 мс
  const stored = await page.evaluate(() => localStorage.getItem("th.threads.v1"));
  const parsed = JSON.parse(stored ?? "{}") as {
    records?: { preset: string; dialogue: unknown[] }[];
  };
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records![0].preset).toBe("rag_chat");
  expect(parsed.records![0].dialogue).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("th.active.v1"))).toBe(tid);

  // сети для boot не нужно: единственный /api-запрос — справочник моделей
  await expect.poll(() => api.calls.length, { timeout: 5_000 }).toBe(1);
  expect(api.calls[0].path).toBe("/api/models");
});
