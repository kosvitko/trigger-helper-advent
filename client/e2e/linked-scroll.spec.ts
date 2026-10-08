/**
 * E2E 14 — linked scroll P2 (D-2): скролл одной колонки ведёт вторую так,
 * что якорь data-turn-id встаёт на «линию фокуса» (верх колонки + 56px),
 * ход в фокусе получает подсветку .focused; leader-by-intent — ведёт та
 * колонка, которую скроллят. Якоря — ходы, восстановленные из ЛОКАЛЬНОГО
 * треда: id сообщения = `<threadId>:<index>` (seeding — фиксированный id),
 * бабл и скелет трейса (mergeThread) несут один и тот же data-turn-id.
 * reduced-motion — instant-скролл (без анимации) для детерминизма.
 */
import { test, expect } from "@playwright/test";
import { e2eThreadRecord } from "./fixtures";
import { mockChat, seedLocalData } from "./helpers";

const THREAD_ID = "th-scroll";
const TURNS = 14;
const FOCUS_OFFSET = 56;
const TOL = 120;

/** id ассистент-бабла хода k (1-based): `<threadId>:<2k-1>`. */
const turnId = (k: number) => `${THREAD_ID}:${2 * k - 1}`;

/** Тред с N ходами: высокие ассистент-баблы (обе колонки заведомо скроллятся). */
function scrollThread() {
  const dialogue: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 1; i <= TURNS; i += 1) {
    dialogue.push({ role: "user", content: `ls-q${i}: вопрос хода ${i}` });
    dialogue.push({
      role: "assistant",
      content: `ls-a${i}: ответ хода ${i}\n${"строка ответа, чтобы бабл был высоким\n".repeat(14)}`,
    });
  }
  return e2eThreadRecord({
    id: THREAD_ID,
    title: "Демо · скролл",
    createdAt: "2026-10-02T09:00:00.000Z",
    updatedAt: "2026-10-02T12:00:00.000Z",
    dialogue,
  });
}

test.describe("linked scroll (P2, D-2)", () => {
  test.use({ viewport: { width: 1280, height: 460 } });

  test("лента ведёт трейс и трейс ведёт ленту: якорь на линии фокуса, .focused", async ({ page, context }) => {
    await mockChat(context);
    await seedLocalData(context, { threads: [scrollThread()] });
    await page.emulateMedia({ reducedMotion: "reduce" }); // instant-скролл ведомого
    await page.goto("/");

    // лента и трейс восстановлены из треда, якоря data-turn-id на обеих сторонах
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(TURNS)}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`.trace .turn[data-turn-id="${turnId(1)}"]`)).toBeVisible();

    const feed = page.locator("[data-feed]");
    const trace = page.locator("[data-trace]");

    // проверка имеет смысл только если обе колонки реально скроллятся
    expect(await feed.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
    expect(await trace.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);

    /** Отступ якоря от верха контейнера (цель ≈ FOCUS_OFFSET ± TOL). */
    const topDelta = (anchor: ReturnType<typeof page.locator>, box: ReturnType<typeof page.locator>) =>
      Promise.all([anchor.boundingBox(), box.boundingBox()]).then(([ab, bb]) =>
        ab && bb ? ab.y - bb.y : null,
      );

    // — фаза 1: лента ведёт — бабл хода 3 на линию фокуса —
    // (live-rects: offsetTop у .msg считается от document — контейнер не positioned)
    await feed.evaluate((el, sel) => {
      const b = el.querySelector<HTMLElement>(sel);
      if (b) el.scrollTop += b.getBoundingClientRect().top - el.getBoundingClientRect().top - 56;
    }, `[data-turn-id="${turnId(3)}"]`);
    const turn3 = page.locator(`.trace .turn[data-turn-id="${turnId(3)}"]`);
    await expect(turn3).toHaveClass(/focused/, { timeout: 5_000 });
    await expect
      .poll(() => topDelta(turn3, trace), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    expect(await topDelta(turn3, trace)).toBeGreaterThanOrEqual(FOCUS_OFFSET - TOL);

    // пауза > hard-cap программного скролла (800 мс) — guard гарантированно снят
    await page.waitForTimeout(900);

    // — фаза 2: трейс ведёт — блок хода 6 на линию фокуса —
    await trace.evaluate((el, sel) => {
      const t = el.querySelector<HTMLElement>(sel);
      if (t) el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 56;
    }, `[data-turn-id="${turnId(6)}"]`);
    const turn6 = page.locator(`.trace .turn[data-turn-id="${turnId(6)}"]`);
    await expect(turn6).toHaveClass(/focused/, { timeout: 5_000 });
    const bubble6 = page.locator(`.msg.bot[data-turn-id="${turnId(6)}"]`);
    await expect
      .poll(() => topDelta(bubble6, feed), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    expect(await topDelta(bubble6, feed)).toBeGreaterThanOrEqual(FOCUS_OFFSET - TOL);
  });

  test("клик по баблу и по ходу выравнивает обе колонки (Костя 04.10)", async ({ page, context }) => {
    await mockChat(context);
    await seedLocalData(context, { threads: [scrollThread()] });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(TURNS)}"]`)).toBeVisible({ timeout: 10_000 });

    const feed = page.locator("[data-feed]");
    const trace = page.locator("[data-trace]");
    const topDelta = (anchor: ReturnType<typeof page.locator>, box: ReturnType<typeof page.locator>) =>
      Promise.all([anchor.boundingBox(), box.boundingBox()]).then(([ab, bb]) =>
        ab && bb ? ab.y - bb.y : null,
      );

    // — клик по ассистент-баблу хода 2: обе колонки ставят ход на линию фокуса —
    await page.locator(`.msg.bot[data-turn-id="${turnId(2)}"]`).click();
    const turn2 = page.locator(`.trace .turn[data-turn-id="${turnId(2)}"]`);
    const bubble2 = page.locator(`.msg.bot[data-turn-id="${turnId(2)}"]`);
    await expect(turn2).toHaveClass(/focused/, { timeout: 5_000 });
    await expect
      .poll(() => topDelta(bubble2, feed), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    await expect
      .poll(() => topDelta(turn2, trace), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);

    // guard гарантированно снят (hard-cap 800 мс)
    await page.waitForTimeout(900);

    // — клик по заголовку хода 10 в трейсе: обе колонки на ход 10 —
    await page.locator(`.trace .turn[data-turn-id="${turnId(10)}"] .tsummary`).click();
    const turn10 = page.locator(`.trace .turn[data-turn-id="${turnId(10)}"]`);
    const bubble10 = page.locator(`.msg.bot[data-turn-id="${turnId(10)}"]`);
    await expect(turn10).toHaveClass(/focused/, { timeout: 5_000 });
    await expect
      .poll(() => topDelta(bubble10, feed), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    await expect
      .poll(() => topDelta(turn10, trace), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
  });
});
