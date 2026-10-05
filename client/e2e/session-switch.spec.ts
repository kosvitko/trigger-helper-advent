/**
 * E2E 10 — session switch (баг 2, строгий): два инстанса с разными тредами;
 * переключение показывает ТОЛЬКО тред этой сессии — без утечки сообщений
 * предыдущей; переключение обратно — тоже чисто.
 */
import { test, expect } from "@playwright/test";
import { AGENT_A2, AGENT_B, INST_A_ID, INST_B_ID } from "./fixtures";
import { mockApi } from "./helpers";

test("переключение сессий: лента без утечки чужих сообщений", async ({ page, context }) => {
  await mockApi(context); // треды A и B с разными сообщениями
  await page.goto("/");

  // дефолт: A (пустых тредов нет) — лента = тред A (2 сообщения)
  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(`${INST_A_ID}:${AGENT_A2}`);
  await expect(page.locator(".msg")).toHaveCount(2);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");

  // переключение на B: лента = только тред B
  await sel.selectOption(`${INST_B_ID}:${AGENT_B}`);
  await expect(page.locator(".msg")).toHaveCount(2);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1");
  await expect(page.locator(".msg", { hasText: "a-q1" })).toHaveCount(0); // никакой утечки A→B

  // обратно на A: только A
  await sel.selectOption(`${INST_A_ID}:${AGENT_A2}`);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  await expect(page.locator(".msg", { hasText: "b-q1" })).toHaveCount(0); // и B→A
});
