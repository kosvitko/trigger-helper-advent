/**
 * E2E 6 — boot: шелл рендерится (бренд, сегмент «Диалог | Оба | Трейс»),
 * пустое состояние диалога, комбобокс из мок-инстантов, активен последний
 * rag_chat новейшего инстанта.
 */
import { test, expect } from "@playwright/test";
import { AGENT_A2, INST_A_ID } from "./fixtures";
import { mockApi } from "./helpers";

test("boot: бренд, сегмент, empty-state, комбобокс, активная сессия", async ({ page, context }) => {
  await mockApi(context, { emptyThreads: true });
  await page.goto("/");

  // бренд в шапке
  await expect(page.locator(".brand")).toContainText("Trigger Helper");

  // сегмент-контрол с тремя подписями
  await expect(page.locator(".seg button")).toHaveText(["Диалог", "Оба", "Трейс"]);

  // пустое состояние продуктовым голосом (D-3)
  await expect(page.locator(".feed .empty")).toContainText("Опишите, что болит");

  // селектор чатов: сессия → чаты (optgroup); 2 сессии = 3 чата (A1+A2+B)
  const sel = page.locator("select.session");
  await expect(sel.locator("option")).toHaveCount(3);
  await expect(sel).toHaveValue(`${INST_A_ID}:${AGENT_A2}`); // активен чат A2 новейшего инстанта

  // активный агент — последний rag_chat (A2, не A1): видно в шапке колонки
  await expect(page.locator(".dialog-col .col-h .meta")).toContainText("RAG-чат A2");
});
