/**
 * E2E — селектор чатов в шапке (решение Кости 04.10: обзор уходит из настроек,
 * сессии → чаты одним селектором): optgroup по сессии, переключение чата внутри
 * сессии и между сессиями — лента без утечки чужих тредов, возврат чистый.
 */
import { test, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import {
  AGENT_A2,
  AGENT_B,
  AGENT_CARE,
  INST_A_ID,
  INST_B_ID,
  e2eSettingsInstances,
  e2eSettingsThreadCare,
  e2eSettingsThreadRag,
} from "./fixtures";
import { mockApi, type MockApi } from "./helpers";

/** Базовый mockApi + слой тредов одной сессии с двумя чатами (LIFO поверх базового).
 * ВАЖНО: instances = ОДНА сессия (e2eSettingsInstances), дефолт mockApi — две. */
async function mockTwoChatSession(context: BrowserContext): Promise<MockApi> {
  const api = await mockApi(context, { instances: e2eSettingsInstances() });
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

test("селектор: сессия → чаты (optgroup), переключение внутри сессии без утечки", async ({
  page,
  context,
}) => {
  await mockTwoChatSession(context);
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel.locator("optgroup")).toHaveCount(1);
  await expect(sel.locator("option")).toHaveCount(2);
  await expect(sel).toHaveValue(`${INST_A_ID}:${AGENT_A2}`); // boot: последний rag_chat
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("RAG-чат A2");

  // переключение на Care-чат той же сессии: лента — только его тред
  await sel.selectOption(`${INST_A_ID}:${AGENT_CARE}`);
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("Care-чат");
  await expect(page.locator(".msg.user").first()).toContainText("c-q1");
  await expect(page.locator(".msg", { hasText: "s-q1" })).toHaveCount(0);

  // обратно на RAG-чат — без утечки care → rag
  await sel.selectOption(`${INST_A_ID}:${AGENT_A2}`);
  await expect(page.locator(".msg.user").first()).toContainText("s-q1");
  await expect(page.locator(".msg", { hasText: "c-q1" })).toHaveCount(0);
});

test("селектор: переход между сессиями через чат соседней сессии", async ({ page, context }) => {
  await mockApi(context); // дефолт: сессии A (2 чата) и B (1 чат)
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel.locator("optgroup")).toHaveCount(2);
  await expect(sel.locator("option")).toHaveCount(3);

  await sel.selectOption(`${INST_B_ID}:${AGENT_B}`);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1");
  await expect(page.locator(".msg", { hasText: "a-q1" })).toHaveCount(0);
});
