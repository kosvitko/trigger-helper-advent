/**
 * E2E день 26 — локальная модель (D-26-2/3/4; cust-fix 10.10 — блок слит
 *  в пункт «Модель»: ручка overrides.model одна, пункт меню «Локальная
 *  модель» упразднён):
 *  (а) рантайм ок → в пункте «Модель» групповой дропдаун (облако + локальные)
 *      с бейджами каталога, выбор 0.5b пишется в СУЩЕСТВУЮЩИЙ override
 *      (sessionStorage th.overrides.v1) и переживает reload;
 *  (б) рантайм недоступен → статус «недоступен», записи видны с бейджем,
 *      но не выбираются; в чипе композера локальных записей нет;
 *  (б2) kill-switch (LOCAL_LLM_ENABLED=0) → статус «отключён»;
 *  (в) ход с локальной моделью → живой SSE-прогресс «● N ток» (кадры
 *      приходят с паузами — helpers.localProgress) и ответ рендерится.
 */
import { test, expect } from "@playwright/test";
import { activeThreadId, mockChat } from "./helpers";
import { e2eModels, LOCAL_REPLY } from "./fixtures";

const openSettings = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "⚙ Настройки" }).click();
const navItem = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".settings .nav-item", { hasText: label });
const modelSelect = (page: import("@playwright/test").Page) =>
  page.locator('.settings select[aria-label="Модель ответов"]');
/** Строка каталога (с бейджем .value) по метке записи — select-строку
 *  (опции содержат тот же текст) не задаевает. */
const catalogRow = (page: import("@playwright/test").Page, label: string) =>
  page
    .locator(".settings .row", { hasText: label })
    .filter({ has: page.locator("span.value") });
const runtimeRow = (page: import("@playwright/test").Page) =>
  page.locator(".settings .row", { hasText: "Рантайм Ollama" });

test("локальная модель: каталог с бейджами, выбор 0.5b персистится в th.overrides.v1 и переживает reload", async ({
  page,
  context,
}) => {
  await mockChat(context, { models: e2eModels("available") });
  await page.goto("/");
  await expect(page.locator("select.session")).toHaveCount(1); // boot готов

  await openSettings(page); // секция «Модель» открыта по умолчанию

  // статус рантайма — доступен; каталог с бейджами причин (D-26-4)
  await expect(runtimeRow(page)).toContainText("доступен");
  await expect(catalogRow(page, "Qwen2.5 0.5B")).toContainText("доступна");
  await expect(catalogRow(page, "Qwen2.5 1.5B")).toContainText("не установлена");
  await expect(catalogRow(page, "Qwen2.5 3B")).toContainText("мало RAM");

  // недоступные записи видны в дропдауне, но выбрать нельзя (D-26-4)
  await expect(modelSelect(page).locator("option[value='qwen2.5:1.5b']")).toBeDisabled();
  await expect(modelSelect(page).locator("option[value='qwen2.5:3b']")).toBeDisabled();

  // выбор доступной записи → единый override (ручка одна на облако и локальные)
  await modelSelect(page).selectOption("qwen2.5:0.5b");
  const stored = await page.evaluate(() => sessionStorage.getItem("th.overrides.v1"));
  expect(JSON.parse(stored ?? "{}")).toMatchObject({ model: "qwen2.5:0.5b" });

  // персист переживает reload
  await page.reload();
  await expect(page.locator("select.session")).toHaveCount(1);
  await openSettings(page);
  await expect(modelSelect(page)).toHaveValue("qwen2.5:0.5b");
});

test("рантайм недоступен: секция «недоступен», в чипе композера локальных нет", async ({
  page,
  context,
}) => {
  await mockChat(context, { models: e2eModels("down") });
  await page.goto("/");
  await expect(page.locator("select.session")).toHaveCount(1);

  // чип: облачные записи на месте, локальных нет (доступных записей — ноль)
  const chipOptions = page.locator(".model-chip option");
  await expect(chipOptions.filter({ hasText: "deepseek-chat" })).toHaveCount(1);
  await expect(chipOptions.filter({ hasText: "локальная" })).toHaveCount(0);

  await openSettings(page);
  await expect(runtimeRow(page)).toContainText("недоступен");
  // записи каталога видны, но все с бейджем «рантайм недоступен» и не выбираются
  await expect(catalogRow(page, "Qwen2.5 0.5B")).toContainText("рантайм недоступен");
  await expect(modelSelect(page).locator("option[value='qwen2.5:0.5b']")).toBeDisabled();
});

test("kill-switch LOCAL_LLM_ENABLED=0: секция «отключён»", async ({ page, context }) => {
  await mockChat(context, { models: e2eModels("disabled") });
  await page.goto("/");
  await expect(page.locator("select.session")).toHaveCount(1);

  const chipOptions = page.locator(".model-chip option");
  await expect(chipOptions.filter({ hasText: "deepseek-chat" })).toHaveCount(1);
  await expect(chipOptions.filter({ hasText: "локальная" })).toHaveCount(0);

  await openSettings(page);
  await expect(runtimeRow(page)).toContainText("отключён");
  await expect(catalogRow(page, "Qwen2.5 0.5B")).toContainText("рантайм недоступен");
  await expect(modelSelect(page).locator("option[value='qwen2.5:0.5b']")).toBeDisabled();
});

test("ход с локальной моделью: SSE-прогресс «● N ток» виден в стриме, ответ рендерится", async ({
  page,
  context,
}) => {
  const api = await mockChat(context, {
    models: e2eModels("available"),
    sse: true,
    localProgress: true, // живой стрим: кадры с паузами (helpers.localProgressServer)
  });
  // выбираем 0.5b ДО загрузки страницы — тот же override-канал настроек
  await context.addInitScript(() => {
    sessionStorage.setItem("th.overrides.v1", JSON.stringify({ model: "qwen2.5:0.5b" }));
  });
  await page.goto("/");
  const tid = await activeThreadId(page); // без посева тредов ensureActive создаёт rag_chat

  // чип: доступная локальная запись с префиксом; активный пресет rag_chat → суффикс « · RAG»
  // (день 28: локальная ветка в rag_chat делает retrieval — proposals 261009 §3.1)
  await expect(
    page.locator(".model-chip option", { hasText: "локальная · Qwen2.5 0.5B · RAG" }),
  ).toHaveCount(1);

  await page.locator("#composer-input").fill("Как снять напряжение с трапеции?");
  await page.locator("#composer-send").click();

  // прогресс локальной генерации виден ПОКА ИДЁТ стрим (titleMap local-gen +
  // текст кадра): первый кадр релеится сразу, последующие прокси-слой может
  // склеивать с done — поэтому живость стрима доказываем первым кадром +
  // незакрытым ходом (typing), финал — отдельно.
  await expect(page.locator(".trace .what", { hasText: "Генерация (локальная)" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator(".trace .sub", { hasText: "● 4 ток" })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#composer-send", { hasText: "Отправляем…" })).toBeVisible();

  // финал: ответ рендерится в ленте (ход заменяет pending-ход с прогрессом)
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:1"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:1"]`, { hasText: LOCAL_REPLY })).toBeVisible();

  // локальный id ушёл в overrides запроса; один ход — без дублей
  expect(api.chatCalls).toHaveLength(1);
  expect(api.chatCalls[0].body).toMatchObject({ overrides: { model: "qwen2.5:0.5b" }, preset: "rag_chat" });
});
