/**
 * E2E 11 — reload: перезагрузка страницы восстанавливает тред активной
 * сессии из mocked messages; per-agent кэш трейса восстанавливается из
 * sessionStorage (ход после reload виден в трейсе без нового run).
 */
import { test, expect } from "@playwright/test";
import { RUN_ANS_ID } from "./fixtures";
import { mockApi } from "./helpers";

test("reload: тред восстановлен, per-agent кэш трейса жив", async ({ page, context }) => {
  const api = await mockApi(context, { emptyThreads: true });
  await page.goto("/");

  // ход → run-ответ пишется в stateful-мок треда
  await page.locator("#composer-input").fill("Болит шея справа, что делать?");
  await page.locator("#composer-send").click();
  await expect(page.locator(`.msg.bot[data-turn-id="${RUN_ANS_ID}"]`)).toBeVisible({ timeout: 10_000 });
  // кэш write-behind: ждём debounce 500 мс
  await page.waitForTimeout(800);

  // reload
  await page.reload({ waitUntil: "networkidle" });

  // тред восстановлен из GET messages (stateful-мок дописал ход)
  await expect(page.locator(`.msg.bot[data-turn-id="${RUN_ANS_ID}"]`)).toBeVisible({ timeout: 10_000 });

  // кэш трейса per-agent: ход в трейсе без нового run
  const turn = page.locator(`.trace .turn[data-turn-id="${RUN_ANS_ID}"]`);
  await expect(turn).toBeVisible({ timeout: 5_000 });
  expect(api.calls.filter((c) => c.path === "/api/agent/run")).toHaveLength(1); // reload не дублирует
});
