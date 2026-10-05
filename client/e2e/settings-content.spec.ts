/**
 * E2E 14 — контент всех вкладок настроек (директива заказчика после бага
 * «прочерков»: каждая вкладка показывает ЖИВЫЕ данные контрактов, а не
 * прочерки/заглушки). Мок — реальная прод-форма /api/rag/stats; assert'ы —
 * на КОНТЕНТ (числа, модели), не на «элемент присутствует». Плюс: персист
 * override модели (reload). Обзор сессии убран из настроек (→ селектор шапки).
 */
import { test, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import {
  AGENT_A2,
  AGENT_CARE,
  INST_A_ID,
  e2eSettingsInstances,
  e2eSettingsThreadCare,
  e2eSettingsThreadRag,
} from "./fixtures";
import { mockApi, type MockApi } from "./helpers";

/**
 * Базовый mockApi + верхний слой тредов с usage/cost (регистрируется ПОСЛЕ —
 * LIFO получает запрос первым, остальное → route.fallback() в базовый мок).
 */
async function mockSettingsApi(
  context: BrowserContext,
  instances: unknown = e2eSettingsInstances(),
): Promise<MockApi> {
  const api = await mockApi(context, { instances });
  const threads = new Map<string, Record<string, unknown>>([
    [`t/${INST_A_ID}/${AGENT_A2}`, e2eSettingsThreadRag()],
    [`t/${INST_A_ID}/${AGENT_CARE}`, e2eSettingsThreadCare()],
  ]);
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const m = new URL(req.url()).pathname.match(
      /^\/api\/instances\/([^/]+)\/agents\/([^/]+)\/messages$/,
    );
    if (m && req.method() === "GET") {
      const th = threads.get(`t/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
      if (th) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(th) });
      }
    }
    return route.fallback();
  });
  return api;
}

const openSettings = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "⚙ Настройки" }).click();
const navItem = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".settings .nav-item", { hasText: label });

test("все вкладки настроек показывают живые данные: модели, стратегии, RAG-статистика", async ({
  page,
  context,
}) => {
  await mockSettingsApi(context);
  await page.goto("/");
  await expect(page.locator(".msg.user").first()).toContainText("s-q1"); // boot: активен RAG-чат

  await openSettings(page);

  // — «Модель»: дропдаун со ЗАМОКанными моделями + тумблер рельсы —
  const modelSelect = page.locator(".settings select");
  await expect(modelSelect).toHaveCount(1);
  await expect(modelSelect).toContainText("Chat · deepseek-chat");
  await expect(modelSelect).toContainText("Reasoner · deepseek-reasoner");
  await expect(modelSelect).toContainText("по умолчанию агента");
  const toggle = page.getByRole("switch", { name: "Жёсткая рельса источников" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // — «Контекст и память»: стратегии + автосжатие —
  await navItem(page, "Контекст и память").click();
  const strategySelect = page.locator(".settings select");
  for (const value of ["sliding", "facts", "branching"]) {
    await expect(strategySelect.locator(`option[value="${value}"]`)).toHaveCount(1);
  }
  await expect(page.locator('.settings input[type="number"]')).toHaveCount(1);

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
  await mockSettingsApi(context);
  await page.goto("/");
  await expect(page.locator(".msg.user").first()).toContainText("s-q1");

  await openSettings(page);
  await page.locator(".settings select").selectOption("deepseek-reasoner");
  const stored = await page.evaluate(() => sessionStorage.getItem("th.overrides.v1"));
  expect(JSON.parse(stored ?? "{}")).toMatchObject({ model: "deepseek-reasoner" });

  await page.reload();
  await expect(page.locator(".msg.user").first()).toContainText("s-q1"); // boot жив после reload
  await openSettings(page);
  await expect(page.locator(".settings select")).toHaveValue("deepseek-reasoner");
});
