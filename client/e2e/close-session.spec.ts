/**
 * E2E 12 — close session + undo: «✕ сессия» удаляет сессию из комбо-бокса
 * (DELETE + снапшот), тост «Сессия «…» закрыта.» с кнопкой «Вернуть»
 * восстанавливает сессию и выбирает её (лента — её тред); единственная
 * сессия не закрывается — кнопка disabled.
 */
import { test, expect } from "@playwright/test";
import { AGENT_A2, AGENT_B, INST_A_ID, e2eInstances } from "./fixtures";
import { mockApiWithClose } from "./close-mock";

test("✕ сессия: сессия исчезает из комбобокса, «Вернуть» восстанавливает и выбирает", async ({ page, context }) => {
  const api = await mockApiWithClose(context); // сессии A (новее) и B, активна A
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(`${INST_A_ID}:${AGENT_A2}`);
  await expect(sel.locator("option")).toHaveCount(3); // чаты: A1 + A2 + B

  await page.locator("#close-session").click();

  // DELETE ушёл; сессии A больше нет в комбобоксе, активна соседняя B
  expect(
    api.closeCalls.filter((c) => c.method === "DELETE" && c.path === `/api/instances/${INST_A_ID}`),
  ).toHaveLength(1);
  await expect(sel.locator("option")).toHaveCount(1);
  await expect(sel).toHaveValue(`inst-b:${AGENT_B}`);
  await expect(page.locator(".msg.user").first()).toContainText("b-q1"); // лента B

  // тост undo с текстом и кнопкой «Вернуть»
  const toast = page.locator(".undo");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Сессия «Демо · шея» закрыта.");

  await toast.locator("button", { hasText: "Вернуть" }).click();

  // сессия вернулась в комбобокс и выбрана; лента — её тред
  await expect(sel.locator("option")).toHaveCount(3);
  await expect(sel).toHaveValue(`${INST_A_ID}:${AGENT_A2}`);
  await expect(page.locator(".msg.user").first()).toContainText("a-q1");
  expect(
    api.closeCalls.filter((c) => c.method === "POST" && c.path === "/api/instances/restore"),
  ).toHaveLength(1);
});

test("✕ сессия disabled, когда сессия одна", async ({ page, context }) => {
  const a2 = e2eInstances().instances.find((i) => i.id === INST_A_ID)!.agents[1];
  await mockApiWithClose(context, {
    instances: {
      instances: [
        { id: "inst-solo", label: "Демо · одна", createdAt: "2026-10-02T09:00:00.000Z", agents: [a2] },
      ],
      caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 1 },
    },
  });
  await page.goto("/");

  const sel = page.locator("select.session");
  await expect(sel).toHaveValue(`inst-solo:${AGENT_A2}`);
  await expect(page.locator("#close-session")).toBeDisabled();
});
