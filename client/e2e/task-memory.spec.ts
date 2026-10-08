/**
 * E2E 13 — TaskMemoryCard (C+ CH-5b): состояние «Память задачи» — per-тред
 * в localStorage (th.threadState.v1), сеть не участвует. Рендер цели/
 * уточнений/ограничений из засеянного состояния; правка поля + blur —
 * ЛОКАЛЬНЫЙ PATCH (ноль не-GET запросов), значение переживает reload;
 * сворачивание чисто визуальное.
 */
import { test, expect } from "@playwright/test";
import { TASK_GOAL, TASK_GOAL_EDITED, e2eNeckThread, e2eNeckThreadState } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

async function seedTaskThread(page: import("@playwright/test").Page) {
  await page.goto("/");
  const task = page.locator(".task");
  await expect(task).toBeVisible({ timeout: 5_000 });
  return task;
}

test("правка цели: локально, без сети; значение переживает reload", async ({ page, context }) => {
  const api = await mockChat(context);
  await seedLocalData(context, {
    threads: [e2eNeckThread()],
    threadState: [e2eNeckThreadState()],
  });
  const task = await seedTaskThread(page);

  // цель и ограничение из засеянного threadState
  await expect(task).toContainText(TASK_GOAL);
  await expect(task).toContainText("без задержки дыхания");

  // правка: войти в режим редактирования → цель-инпут
  await task.locator("button.link", { hasText: "изменить" }).click();
  const goalField = task.locator("label:has-text('Цель') input");
  await expect(goalField).toHaveValue(TASK_GOAL);
  await goalField.fill(TASK_GOAL_EDITED);
  await goalField.blur();

  // PATCH теперь локальный: ноль не-GET /api-запросов
  await page.waitForTimeout(800); // write-behind debounce 500 мс
  expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);

  // состояние персистится в th.threadState.v1
  const stored = await page.evaluate(() => localStorage.getItem("th.threadState.v1"));
  const parsed = JSON.parse(stored ?? "{}") as { records?: { chatTask?: { goal?: string } }[] };
  expect(parsed.records?.[0]?.chatTask?.goal).toBe(TASK_GOAL_EDITED);

  // reload: панель показывает отредактированную цель
  await page.reload();
  const taskAfter = page.locator(".task");
  await expect(taskAfter).toBeVisible({ timeout: 5_000 });
  await expect(taskAfter).toContainText(TASK_GOAL_EDITED);
});

test("память задачи сворачивается: шапка остаётся, тело скрыто, сеть молчит (Костя 04.10)", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  await seedLocalData(context, {
    threads: [e2eNeckThread()],
    threadState: [e2eNeckThreadState()],
  });
  const task = await seedTaskThread(page);
  await expect(task).toContainText(TASK_GOAL);

  // Свернуть: шапка-кнопка остаётся, контент и «изменить» скрыты
  const tgl = task.locator("button.tgl");
  await tgl.click();
  await expect(tgl).toHaveAttribute("aria-expanded", "false");
  await expect(task).not.toContainText(TASK_GOAL);
  await expect(task.locator("button.link", { hasText: "изменить" })).toHaveCount(0);
  await expect(task).toContainText("Память задачи"); // шапка жива

  // Развернуть обратно: контент возвращается
  await tgl.click();
  await expect(tgl).toHaveAttribute("aria-expanded", "true");
  await expect(task).toContainText(TASK_GOAL);

  // Сворачивание чисто визуальное: ни одного не-GET запроса за тест
  expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});
