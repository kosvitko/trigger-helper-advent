/**
 * E2E 8 — dialog flow (C+ CH-5b, мок POST /api/chat): ввод → один клик →
 * ровно один user-бабл; typing-индикатор; ассистент-бабл .msg.bot[data-turn-id]
 * с клиентским turnId `<threadId>:<index>`; SourcesChip «Источники N ·
 * цитаты M/M ✓» свёрнут → раскрытие карточек с [source › section]; TurnBlock
 * в трейсе; второй ход несёт contextTail.dialogue с первым ходом и уникальный
 * clientTurnId.
 */
import { test, expect } from "@playwright/test";
import { RAG_REPLY } from "./fixtures";
import { activeThreadId, type ChatRequestBody, mockChat } from "./helpers";

const Q1 = "Болит шея справа, что делать?";
const Q2 = "А если боль отдаёт в голову?";

test("диалог: send → бабл + SourcesChip + трейс-ход + contextTail второго хода", async ({ page, context }) => {
  const api = await mockChat(context, { chatDelayMs: 400 });
  await page.goto("/");
  const tid = await activeThreadId(page);

  // typing-индикатор появляется во время хода (chatDelayMs=400 — окно)
  await page.locator("#composer-input").fill(Q1);
  await page.locator("#composer-send").click();
  await expect(page.locator(".feed .typing")).toBeVisible();

  // ровно один POST /api/chat (двойной клик не дублирует — busy-guard)
  await page.locator("#composer-send").click({ timeout: 1_000 }).catch(() => {});
  const assistant = page.locator(`.msg.bot[data-turn-id="${tid}:1"]`);
  await expect(assistant).toBeVisible({ timeout: 10_000 });
  expect(api.chatCalls).toHaveLength(1);

  // ровно один user-бабл (optimistic, local-*)
  await expect(page.locator(".msg.user")).toHaveCount(1);
  // typing исчез
  await expect(page.locator(".feed .typing")).toHaveCount(0);

  // SourcesChip: «Источники N» (+ ✓ если все цитаты верифицированы)
  const chip = page.locator(".src-chip");
  await expect(chip).toContainText("Источники");
  await expect(chip).toContainText("2/2");
  await expect(page.locator(".qcard")).toHaveCount(0); // свёрнуто

  // раскрытие: карточки цитат с [source › section]
  await chip.click();
  const cards = page.locator(".qcard");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator(".qlabel")).toContainText("[travell-guide › Шея]");
  await expect(cards.first().locator(".qlabel.ok")).toBeVisible(); // верифицирована

  // трейс: TurnBlock с тем же data-turn-id и заголовком хода
  const turn = page.locator(`.trace .turn[data-turn-id="${tid}:1"]`);
  await expect(turn).toBeVisible();
  await expect(turn.locator(".tno")).toContainText("Ход 1");
  await expect(turn.locator(".tm")).toContainText("deepseek-chat");
  await expect(turn.locator(".tm")).toContainText("2.1k");
  // шаги: авто-раскрытие нового хода (UX-фикс 03.10) — шаги уже видны
  // (если не видно — клик по .tsummary раскроет)
  const stepSel = turn.locator(".step-wrap .what", { hasText: "rag_ask" });
  if (!(await stepSel.isVisible().catch(() => false))) {
    await turn.locator(".tsummary").click(); // фолбэк: ручное раскрытие
  }
  await expect(stepSel).toBeVisible();

  // — второй ход: хвост контекста собирается из локального треда —
  await page.locator("#composer-input").fill(Q2);
  await page.locator("#composer-send").click();
  await expect(page.locator(`.msg.bot[data-turn-id="${tid}:3"]`)).toBeVisible({ timeout: 10_000 });
  expect(api.chatCalls).toHaveLength(2);

  const first = api.chatCalls[0].body as ChatRequestBody;
  expect(first.input).toBe(Q1);
  expect(first.preset).toBe("rag_chat");
  expect(first.contextTail?.dialogue).toEqual([]); // первый ход — пустой хвост

  const second = api.chatCalls[1].body as ChatRequestBody;
  // хвост несёт диалог первого хода (D-3: контекст поставляет клиент)
  expect(second.contextTail?.dialogue).toEqual([
    { role: "user", content: Q1 },
    { role: "assistant", content: RAG_REPLY },
  ]);
  expect(second.input).toBe(Q2);
  // clientTurnId: безконтентная корреляция логов (D-6) — присутствует и уникальна
  expect(typeof second.clientTurnId).toBe("string");
  expect((second.clientTurnId ?? "").length).toBeGreaterThanOrEqual(8);
  expect(second.clientTurnId).not.toBe(first.clientTurnId);
  // триггер сжатия (Q-2): хвост из 2 сообщений не дотягивает до every=10
  expect(second.compress).toBeFalsy();
});
