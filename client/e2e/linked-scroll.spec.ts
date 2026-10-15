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
    // (wheel-событие = живой интент: без него трейс-лидер игнорируется)
    await trace.evaluate((el, sel) => {
      el.dispatchEvent(new Event("wheel"));
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

  test("длинный чат: отправка Enter без мыши — хвост остаётся хвостом (репорт 261015)", async ({ page, context }) => {
    await mockChat(context);
    await seedLocalData(context, { threads: [scrollThread()] });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(TURNS)}"]`)).toBeVisible({ timeout: 10_000 });

    const feed = page.locator("[data-feed]");
    const trace = page.locator("[data-trace]");
    /** 0 = прижат к низу. */
    const gap = (box: ReturnType<typeof page.locator>) =>
      box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    /** Отступ якоря от верха контейнера. */
    const topDelta = (anchor: ReturnType<typeof page.locator>, box: ReturnType<typeof page.locator>) =>
      Promise.all([anchor.boundingBox(), box.boundingBox()]).then(([ab, bb]) =>
        ab && bb ? ab.y - bb.y : null,
      );

    // после загрузки длинного треда лента прижата к низу
    await expect.poll(() => gap(feed), { timeout: 5_000 }).toBeLessThanOrEqual(2);

    // отправка клавиатурой (репро: без мыши) — фокус в композере, Enter
    await page.locator("#composer-input").fill("ls-q15: вопрос хода 15");
    await page.keyboard.press("Enter");

    // ход 15 в фокусе трейса
    const turn15 = page.locator(`.trace .turn[data-turn-id="${turnId(15)}"]`);
    await expect(turn15).toHaveClass(/focused/, { timeout: 10_000 });

    // хвост очереди проехал (typing → ответ) — диалог НЕ отмотан к старому ходу
    await page.waitForTimeout(1_200);
    await expect.poll(() => gap(feed), { timeout: 5_000 }).toBeLessThanOrEqual(2);

    // трейс — новый ход у линии фокуса, не «второй сверху старый»
    await expect
      .poll(() => topDelta(turn15, trace), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(FOCUS_OFFSET - TOL);
    expect(await topDelta(turn15, trace)).toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
  });

  test("stick-to-bottom: чтение истории не прерывается автоскроллом; возврат к краю возвращает его (Костя 15.10)", async ({ page, context }) => {
    await mockChat(context);
    await seedLocalData(context, { threads: [scrollThread()] });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(TURNS)}"]`)).toBeVisible({ timeout: 10_000 });

    const feed = page.locator("[data-feed]");
    const gap = (box: ReturnType<typeof page.locator>) =>
      box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

    // — фаза 1: пользователь уехал читать историю (верх ленты) —
    await feed.evaluate((el) => {
      el.scrollTop = 0;
    });

    // ход 15 приходит, а лента стоит на истории — автоскролл не дёргает
    await page.locator("#composer-input").fill("ls-q15: вопрос хода 15");
    await page.keyboard.press("Enter");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(15)}"]`)).toBeVisible({ timeout: 10_000 });
    expect(await feed.evaluate((el) => el.scrollTop)).toBe(0);

    // — фаза 2: возврат к нижнему краю — автоскролл возвращается —
    await feed.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.locator("#composer-input").fill("ls-q16: вопрос хода 16");
    await page.keyboard.press("Enter");

    const turn16 = page.locator(`.trace .turn[data-turn-id="${turnId(16)}"]`);
    await expect(turn16).toHaveClass(/focused/, { timeout: 10_000 });
    await expect.poll(() => gap(feed), { timeout: 5_000 }).toBeLessThanOrEqual(24);
  });

  test("чтение истории через трейс: отправка и ответ модели не дёргают экраны (репорт 261015-2)", async ({ page, context }) => {
    await mockChat(context);
    await seedLocalData(context, { threads: [scrollThread()] });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(TURNS)}"]`)).toBeVisible({ timeout: 10_000 });

    const feed = page.locator("[data-feed]");
    const trace = page.locator("[data-trace]");

    // пользователь уехал читать историю ЧЕРЕЗ трейс (wheel + скролл)
    await trace.evaluate((el, sel) => {
      el.dispatchEvent(new Event("wheel"));
      const t = el.querySelector<HTMLElement>(sel);
      if (t) el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 56;
    }, `[data-turn-id="${turnId(4)}"]`);

    // лента синхронизировалась за трейсом — мы в истории, не у хвоста
    const bubble4 = page.locator(`.msg.bot[data-turn-id="${turnId(4)}"]`);
    await expect.poll(() => feed.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(200);
    await expect(bubble4).toBeVisible();

    const feedTop = await feed.evaluate((el) => el.scrollTop);
    const traceTop = await trace.evaluate((el) => el.scrollTop);

    // отправка без мыши + ответ модели — экраны стоят на истории:
    // без дёрганья вниз-обратно и без автоскролла к хвосту
    await page.locator("#composer-input").fill("ls-q15: читаю историю");
    await page.keyboard.press("Enter");
    await expect(page.locator(`.msg.bot[data-turn-id="${turnId(15)}"]`)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(900); // хвост: typing ушёл, трейс доложил ход

    expect(Math.abs((await feed.evaluate((el) => el.scrollTop)) - feedTop)).toBeLessThanOrEqual(4);
    expect(Math.abs((await trace.evaluate((el) => el.scrollTop)) - traceTop)).toBeLessThanOrEqual(40);
  });
});
