/**
 * E2E (C+ CH-5b, D-7) — данные на устройстве: export/import round-trip через
 * SettingsScreen. Облака нет — только localStorage: экспорт скачивает один
 * JSON со всеми коллекциями (счётчики в интерфейсе); импорт заменяет
 * коллекции целиком («последний импорт выигрывает», 02-F9) и показывает
 * счётчики. Плюс: ход с memoryDelta/compress/contextTrimmed — панель памяти
 * обновляется из дельты, бейджи «Сжатие истории» / «Контекст обрезан» в
 * трейсе, сводка замещает префикс треда (Q-2).
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPRESS_SUMMARY,
  MEMORY_DELTA_GOAL,
  THREAD_BACK,
  THREAD_NECK,
  e2eBackThread,
  e2eChatRag,
  e2eNeckThread,
} from "./fixtures";
import { activeThreadId, mockChat, seedLocalData } from "./helpers";

const openDataTab = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "⚙ Настройки" }).click();
  await page.locator(".settings .nav-item", { hasText: "Данные (на устройстве)" }).click();
};

test("экспорт: скачивается JSON всех коллекций, счётчики в интерфейсе", async ({ page, context }) => {
  await mockChat(context);
  await seedLocalData(context, { threads: [e2eBackThread(), e2eNeckThread()] });
  await page.goto("/");
  await expect(page.locator("select.session").locator("option")).toHaveCount(2);

  await openDataTab(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Скачать JSON" }).click(),
  ]);

  // имя файла: trigger-helper-YYYY-MM-DD.json
  expect(download.suggestedFilename()).toMatch(/^trigger-helper-\d{4}-\d{2}-\d{2}\.json$/);

  // содержимое: валидный export-файл с обеими коллекциями реестра
  const path = await download.path();
  const file = JSON.parse(readFileSync(path ?? "", "utf8")) as {
    format: string;
    version: number;
    savedAt: string;
    collections: Record<string, unknown[]>;
  };
  expect(file.format).toBe("trigger-helper.export");
  expect(file.version).toBe(1);
  expect(file.savedAt).toBeTruthy();
  expect(file.collections.threads).toHaveLength(2);
  expect(Array.isArray(file.collections.threadState)).toBe(true);

  // счётчики в интерфейсе
  const msg = page.locator(".data-msg");
  await expect(msg).toContainText("Экспортировано —");
  await expect(msg).toContainText("threads: 2");
  await expect(msg).not.toHaveClass(/err/);
});

test("импорт: треды заменяются («последний импорт выигрывает»), счётчики показаны", async ({ page, context }) => {
  await mockChat(context);
  await page.goto("/");
  // boot создал автотред — импорт должен его заменить целиком
  await expect(page.locator("select.session").locator("option")).toHaveCount(1);

  const dir = mkdtempSync(join(tmpdir(), "th-e2e-import-"));
  const filePath = join(dir, "import.json");
  const exportFile = {
    format: "trigger-helper.export",
    version: 1,
    savedAt: "2026-10-06T10:00:00.000Z",
    collections: {
      threads: [e2eBackThread(), e2eNeckThread()],
      threadState: [],
    },
  };
  try {
    writeFileSync(filePath, JSON.stringify(exportFile), "utf8");
    await openDataTab(page);
    await page.locator('.settings input[type="file"]').setInputFiles(filePath);

    // счётчики импорта
    const msg = page.locator(".data-msg");
    await expect(msg).toContainText("Импортировано — threads: 2 · threadState: 0");

    // «последний импорт выигрывает»: список = импортированные треды,
    // автотред исчез; активен новейший импортированный, лента — его диалог
    const sel = page.locator("select.session");
    await expect(sel.locator("option")).toHaveCount(2);
    await expect(sel.locator("option")).toContainText(["Демо · шея", "Демо · поясница"]);
    await expect(sel).toHaveValue(THREAD_NECK);

    // назад к диалогу (грид не рендерится, пока открыт экран настроек)
    await page.getByRole("button", { name: "◂ К диалогу" }).click();
    await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ход с memoryDelta/compress/contextTrimmed: панель памяти, бейджи хода, сводка в треде", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  api.setChat((body) =>
    e2eChatRag(String(body?.input ?? ""), { compress: true, contextTrimmed: true, memoryDelta: true }),
  );
  await page.goto("/");
  const tid = await activeThreadId(page);

  await page.locator("#composer-input").fill("Болит шея справа, что делать?");
  await page.locator("#composer-send").click();
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:1"]`)).toBeVisible({ timeout: 10_000 });

  // memoryDelta (Q-3): «Память задачи» обновилась из дельты хода
  const task = page.locator(".task");
  await expect(task).toContainText(MEMORY_DELTA_GOAL);

  // трейс: шаги «Сжатие истории» (Q-2) и «Контекст обрезан» (SEC-F4)
  const turn = page.locator(`.trace .turn[data-turn-id="${tid}:1"]`);
  await expect(turn).toBeVisible();
  const ensureStep = async (text: string) => {
    const sel = turn.locator(".step-wrap", { hasText: text });
    if (!(await sel.isVisible().catch(() => false))) {
      await turn.locator(".tsummary").click();
    }
    await expect(sel).toBeVisible();
  };
  await ensureStep("Сжатие истории");
  await ensureStep("Контекст обрезан");

  // локальный тред: сводка заместила префикс, диалог = keptTail + пара хода
  await page.waitForTimeout(900); // write-behind debounce 500 мс
  const stored = await page.evaluate(() => localStorage.getItem("th.threads.v1"));
  const parsed = JSON.parse(stored ?? "{}") as {
    records?: { summaries?: string[]; dialogue?: unknown[] }[];
  };
  const record = parsed.records?.find((r) => r.summaries?.length || r.dialogue?.length);
  expect(record?.summaries).toEqual([COMPRESS_SUMMARY]);
  expect(record?.dialogue).toHaveLength(2); // keptTail [] + пара хода
  expect(api.chatCalls).toHaveLength(1);

  // Второй compress-ход — коллизия индексов (post-compress снова длина 2):
  // лента обязана ребилдиться из треда — ровно два пузыря, вопрос выше
  // ответа (регресс ревью CH-5b MAJOR: без ребилда старый пузырь
  // перезаписывался на месте и порядок ломался).
  const q2 = "А если снова тянет к вечеру?";
  await page.locator("#composer-input").fill(q2);
  await page.locator("#composer-send").click();
  const bubbles = page.locator(".msg");
  await expect(bubbles).toHaveCount(2, { timeout: 10_000 });
  await expect(bubbles.nth(0)).toContainText(q2);
  await expect(bubbles.nth(1)).toContainText("верхней порцией трапеции"); // метки источников рендерятся отдельно (SourcesChip), пузырь — без них
  expect(api.chatCalls).toHaveLength(2);
});
