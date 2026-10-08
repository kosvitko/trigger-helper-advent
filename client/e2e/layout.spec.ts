/**
 * E2E 7 — layout modes: сегмент переключает grid-template-columns между
 * тремя 2-трековыми состояниями (100fr 0fr / 55fr 45fr / 0fr 100fr).
 * Transition 300 мс — ждём успокоения и ассертим финальные значения.
 */
import { test, expect } from "@playwright/test";
import { mockChat } from "./helpers";

test("сегмент переключает 2-трековый грид: Диалог full / Оба split / Трейс full", async ({ page, context }) => {
  await mockChat(context);
  await page.goto("/");

  const cols = page.locator("main.cols");
  await expect(cols).toBeVisible();
  // transition именно на grid-template-columns (требование D-2/05-M-2)
  expect(await cols.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain("grid-template-columns");

  const width = await cols.evaluate((el) => el.clientWidth);
  const tracks = (): Promise<number[]> =>
    cols.evaluate((el) =>
      getComputedStyle(el)
        .gridTemplateColumns.split(/\s+/)
        .map((s) => parseFloat(s.replace(/px$/, "")))
        .filter((n) => Number.isFinite(n)),
    );

  // «Оба» (дефолт): два ненулевых трека ≈55/45
  await page.waitForTimeout(450);
  let t = await tracks();
  expect(t).toHaveLength(2); // всегда 2 трека — интерполяция долей, не числа треков
  expect(t[0]).toBeGreaterThan(width * 0.3);
  expect(t[1]).toBeGreaterThan(width * 0.3);
  expect(t[0] / (t[0] + t[1])).toBeCloseTo(0.55, 1);

  // «Диалог»: диалог full, трейс схлопнут (0fr → 0px)
  await page.locator(".seg button", { hasText: "Диалог" }).click();
  await page.waitForTimeout(500);
  t = await tracks();
  expect(t).toHaveLength(2);
  expect(t[1]).toBeLessThan(2);
  expect(t[0]).toBeGreaterThan(width * 0.9);

  // «Трейс»: трейс full, диалог схлопнут
  await page.locator(".seg button", { hasText: "Трейс" }).click();
  await page.waitForTimeout(500);
  t = await tracks();
  expect(t).toHaveLength(2);
  expect(t[0]).toBeLessThan(2);
  expect(t[1]).toBeGreaterThan(width * 0.9);
});
