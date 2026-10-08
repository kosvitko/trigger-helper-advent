/**
 * E2E 14 — контент всех вкладок настроек (директива заказчика после бага
 * «прочерков»: каждая вкладка показывает ЖИВЫЕ данные контрактов, а не
 * прочерки/заглушки). C+ CH-5b: обзора сессий больше нет — модели
 * (GET /api/models), дефолт автосжатия (GET /api/agents), RAG-статистика
 * (GET /api/rag/stats, реальная прод-форма). Плюс: персист override модели
 * (sessionStorage th.overrides.v1) переживает reload.
 */
import { test, expect } from "@playwright/test";
import { mockChat } from "./helpers";

const openSettings = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "⚙ Настройки" }).click();
const navItem = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".settings .nav-item", { hasText: label });

test("все вкладки настроек показывают живые данные: модели, автосжатие, RAG-статистика", async ({
  page,
  context,
}) => {
  await mockChat(context);
  await page.goto("/");
  await expect(page.locator("select.session")).toHaveCount(1); // boot готов

  await openSettings(page);

  // — «Модель»: дропдаун со замоканными моделями + тумблер рельсы —
  const modelSelect = page.locator(".settings select");
  await expect(modelSelect).toHaveCount(1);
  await expect(modelSelect).toContainText("Chat · deepseek-chat");
  await expect(modelSelect).toContainText("Reasoner · deepseek-reasoner");
  await expect(modelSelect).toContainText("по умолчанию агента");
  const toggle = page.getByRole("switch", { name: "Жёсткая рельса источников" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // — «Контекст и память»: автосжатие с серверским дефолтом —
  await navItem(page, "Контекст и память").click();
  await expect(page.locator('.settings input[type="number"]')).toHaveCount(1);
  // дефолт автосжатия — из мета-справочника /api/agents (autoCompress.defaultEvery)
  const compressRow = page.locator(".settings .row", { hasText: "Автосжатие" });
  await expect(compressRow).toContainText("по умолчанию сервера: 10");

  // — «Поиск по базе»: РЕАЛЬНАЯ прод-статистика, а не «Статистика недоступна» —
  await navItem(page, "Поиск по базе").click();
  const search = page.locator(".settings .card");
  const fixedRow = search.locator(".row", { hasText: "Индекс «fixed»" });
  await expect(fixedRow).toContainText("128 чанков · 43 файлов");
  await expect(fixedRow).toContainText("Xenova/multilingual-e5-small");
  const structuredRow = search.locator(".row", { hasText: "Индекс «structured»" });
  await expect(structuredRow).toContainText("220 чанков");
  const compareRow = search.locator(".row", { hasText: "Контрольные прогоны" });
  await expect(compareRow).toContainText("fixed: 0.50/0.92/0.67");
  await expect(compareRow).toContainText("structured: 0.67/0.83/0.76");
  await expect(compareRow).not.toContainText("—"); // нет голых прочерков вместо метрик
  await expect(search).not.toContainText("—/—/—");
  await expect(page.getByText("Статистика недоступна")).toHaveCount(0);
});

test("персист настроек не сломан: выбор модели переживает reload", async ({ page, context }) => {
  await mockChat(context);
  await page.goto("/");
  await expect(page.locator("select.session")).toHaveCount(1);

  await openSettings(page);
  await page.locator(".settings select").selectOption("deepseek-reasoner");
  const stored = await page.evaluate(() => sessionStorage.getItem("th.overrides.v1"));
  expect(JSON.parse(stored ?? "{}")).toMatchObject({ model: "deepseek-reasoner" });

  await page.reload();
  await expect(page.locator("select.session")).toHaveCount(1); // boot жив после reload
  await openSettings(page);
  await expect(page.locator(".settings select")).toHaveValue("deepseek-reasoner");
});
