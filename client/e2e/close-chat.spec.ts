/**
 * E2E 13 — close chat + undo: «✕ чат» закрывает активного агента сессии
 * (DELETE + снапшот), активен предыдущий сосед, лента перегружается его
 * тредом, тост «Чат «…» закрыт.»; «Вернуть» возвращает агента и его ленту;
 * единственный агент не закрывается — кнопка disabled.
 */
import { test, expect } from "@playwright/test";
import { INST_A_ID, e2eInstances } from "./fixtures";
import { mockApiWithClose } from "./close-mock";

test("✕ чат: активен предыдущий сосед с его тредом, «Вернуть» возвращает агента", async ({ page, context }) => {
  const api = await mockApiWithClose(context, {
    // тред соседнего агента A1 (в базовом моке его нет — был бы пустой тред)
    extraThreads: {
      "inst-a/agent-a1": [
        { id: "msg-a1-q", role: "user", content: "a1-q1: вопрос первого чата", createdAt: "2026-10-02T12:00:00.000Z" },
        { id: "msg-a1-ans", role: "assistant", content: "a1-ans1: ответ первого чата", createdAt: "2026-10-02T12:01:00.000Z" },
      ],
    },
  });
  await page.goto("/");

  const meta = page.locator(".dialog-col .col-h .meta");
  await expect(meta).toContainText("RAG-чат A2"); // активен последний rag_chat
  await expect(page.locator(".msg.user").first()).toContainText("a-q1"); // тред A2

  await page.locator("#close-chat").click();

  // DELETE активного агента; активен предыдущий сосед A1, лента — его тред
  expect(
    api.closeCalls.filter(
      (c) => c.method === "DELETE" && c.path === "/api/instances/inst-a/agents/agent-a2",
    ),
  ).toHaveLength(1);
  await expect(meta).toContainText("RAG-чат A1");
  await expect(meta).not.toContainText("A2");
  await expect(page.locator(".msg.user").first()).toContainText("a1-q1");

  // тост undo с меткой закрытого чата
  const toast = page.locator(".undo");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Чат «RAG-чат A2» закрыт.");

  await toast.locator("button", { hasText: "Вернуть" }).click();

  // агент вернулся активным, лента — снова его тред
  await expect(meta).toContainText("RAG-чат A2");
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  expect(
    api.closeCalls.filter(
      (c) => c.method === "POST" && c.path === "/api/instances/inst-a/agents/restore",
    ),
  ).toHaveLength(1);
});

test("✕ чат disabled, когда в сессии один агент", async ({ page, context }) => {
  const a2 = e2eInstances().instances.find((i) => i.id === INST_A_ID)!.agents[1];
  await mockApiWithClose(context, {
    instances: {
      instances: [
        { id: INST_A_ID, label: "Демо · один чат", createdAt: "2026-10-02T09:00:00.000Z", agents: [a2] },
      ],
      caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 1 },
    },
  });
  await page.goto("/");

  const meta = page.locator(".dialog-col .col-h .meta");
  await expect(meta).toContainText("RAG-чат A2");
  await expect(page.locator("#close-chat")).toBeDisabled();
});
