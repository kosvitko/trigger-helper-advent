/**
 * E2E 22 — хвосты волны C+: задача-FSM (день 13), инварианты (день 14),
 * профиль (день 12) — панели/секция + проводка в contextTail и fsm-кадры
 * в трейсе. Хранение локальное (th.threadState.v1 / th.profiles.v1);
 * сеть — только ход POST /api/chat (mock), панели живут без запросов.
 */
import { test, expect } from "@playwright/test";
import { e2eChatRag, e2eNeckThread } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

async function boot(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#composer-input")).toBeVisible({ timeout: 5_000 });
}

async function sendTurn(page: import("@playwright/test").Page, text: string) {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-send").click();
  await expect(page.locator("#composer-send")).toBeEnabled({ timeout: 10_000 });
}

type Tail = {
  task?: { stage?: string; title?: string };
  invariants?: { id: string; active?: boolean }[];
  profile?: { id?: string; label?: string };
} | void;

function lastTail(calls: { method: string; path: string; body: unknown }[]): Tail {
  const chat = calls.filter((c) => c.method === "POST" && c.path === "/api/chat");
  const body = chat[chat.length - 1]?.body as { contextTail?: Tail } | undefined;
  return body?.contextTail;
}

test("задача-FSM: создание → переход → ход несёт task → персист переживает reload", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await boot(page);

  // создать задачу через карточку
  const card = page.locator(".task-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "+ создать задачу" }).click();
  await card.locator("label:has-text('Название') input").fill("убрать боль в шее");
  await card.locator("label:has-text('План') textarea").fill("найти мышцу\nмассаж 3 минуты");
  await card.getByRole("button", { name: "создать", exact: true }).click();
  await expect(card).toContainText("Разбор");

  // переход по карте: planning → execution
  await card.getByRole("button", { name: "К практике" }).click();
  await expect(card).toContainText("Практика");
  await expect(card).toContainText("шаг 1/2");

  // ход: contextTail.task едет на сервер
  await sendTurn(page, "e2e-tail: вопрос по задаче");
  const tail = lastTail(api.calls);
  expect(tail?.task?.stage).toBe("execution");
  expect(tail?.task?.title).toBe("убрать боль в шее");

  // reload — задача на месте, без сети (ждём write-behind-флэш 500 мс)
  const nonGetBefore = api.calls.filter((c) => c.method !== "GET").length;
  await page.waitForTimeout(800);
  await page.reload();
  const cardAfter = page.locator(".task-card");
  await expect(cardAfter).toContainText("Практика");
  expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(nonGetBefore);
});

test("инварианты: правило через панель → в ходе только активный ряд", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await boot(page);

  const card = page.locator(".inv-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "+ правило" }).click();
  await card.locator("label:has-text('Правило') input").fill("не рекомендуй задержку дыхания");
  await card.getByRole("button", { name: "добавить", exact: true }).click();
  await expect(card).toContainText("не рекомендуй задержку дыхания");
  await expect(card).toContainText("активных: 1 из 1");

  await sendTurn(page, "e2e-tail: вопрос с инвариантом");
  let tail = lastTail(api.calls);
  expect(tail?.invariants).toHaveLength(1);
  expect(tail?.invariants?.[0]?.id).toBeTruthy();

  // выключить ряд → следующий ход без него
  await card.locator("li input[type='checkbox']").click();
  await expect(card).toContainText("активных: 0 из 1");
  await sendTurn(page, "e2e-tail: вопрос без инварианта");
  tail = lastTail(api.calls);
  expect(tail?.invariants).toHaveLength(0);
});

test("профиль: секция настроек → активный едет в contextTail.profile", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await boot(page);

  await sendTurn(page, "e2e-tail: ход без профиля");
  expect(lastTail(api.calls)?.profile).toBeUndefined();

  // настройки → Профиль: создать и активировать
  await page.getByRole("button", { name: "⚙ Настройки" }).click();
  await page.locator(".settings .nav-item", { hasText: "Профиль" }).click();
  await page.getByRole("button", { name: "+ профиль" }).click();
  await page.locator(".prof-edit label:has-text('Название') input").fill("кратко и по шагам");
  await page.getByRole("button", { name: "создать", exact: true }).click();

  // активируем: опция в селекте существует ⇔ профиль сохранён
  const activeSelect = page.locator(".settings select");
  await activeSelect.selectOption({ label: "кратко и по шагам" });

  // вернуться в чат и сходить — профиль в хвосте
  await page.getByRole("button", { name: "◂ К диалогу" }).click();
  await sendTurn(page, "e2e-tail: ход с профилем");
  expect(lastTail(api.calls)?.profile?.label).toBe("кратко и по шагам");
});

test("трейс: кадры задачи/инвариантов хода рендерятся fsm-шагами", async ({
  page,
  context,
}) => {
  const api = await mockChat(context);
  api.setChat((body) => e2eChatRag(String(body?.input ?? ""), { fsmFrames: true }));
  await seedLocalData(context, { threads: [e2eNeckThread()] });
  await boot(page);

  await sendTurn(page, "e2e-tail: ход с fsm-кадрами");

  // чипы шагов в трейсе (последний ход раскрыт автоматически)
  const trace = page.locator("[data-trace]");
  await expect(trace).toContainText("Задача");
  await expect(trace).toContainText("Практика · шаг 1/3");
  await expect(trace).toContainText("Инварианты");
  await expect(trace).toContainText("Инварианты учтены");
});
