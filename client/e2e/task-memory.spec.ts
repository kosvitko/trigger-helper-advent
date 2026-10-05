/**
 * E2E 13 — TaskMemoryCard: рендер chat-task-state (цель/уточнено/ограничения)
 * из GET; правка поля + blur → PATCH с отредактированным payload.
 */
import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test("TaskMemoryCard: рендер + PATCH на blur", async ({ page, context }) => {
  const api = await mockApi(context, { emptyThreads: true });
  await page.goto("/");

  const task = page.locator(".task");
  await expect(task).toBeVisible({ timeout: 5_000 });

  // цель из GET (chatTaskState.goal)
  await expect(task).toContainText("Подобрать самопомощь при боли в шее");
  // ограничение из GET
  await expect(task).toContainText("без задержки дыхания");

  // правка: войти в режим редактирования → цель-инпут (первый input в .task)
  await task.locator("button.link", { hasText: "изменить" }).click();
  const goalField = task.locator("label:has-text('Цель') input");
  await expect(goalField).toHaveValue("Подобрать самопомощь при боли в шее");
  await goalField.fill("Новая цель: разминка шеи каждый час");
  await goalField.blur();

  // PATCH отправлен ровно один, с goal = новое значение
  const patches = api.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/chat-task-state"));
  await expect.poll(() => patches.length).toBeGreaterThanOrEqual(1);
  expect((patches[0].body as Record<string, unknown>).goal).toBe("Новая цель: разминка шеи каждый час");
});
