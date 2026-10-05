/**
 * E2E 14 — linked scroll P2 (D-2): скролл одной колонки ведёт вторую так,
 * что якорь data-turn-id встаёт на «линию фокуса» (верх колонки + 56px),
 * ход в фокусе получает подсветку .focused; leader-by-intent — ведёт та
 * колонка, которую скроллят. Якоря — восстановленные из треда ходы:
 * mergeThread даёт turnId = id ассистент-сообщения, бабл несёт тот же
 * data-turn-id, так что живой run для связки не нужен. reduced-motion —
 * instant-скролл (без анимации) для детерминизма.
 */
import { test, expect } from "@playwright/test";
import type { AgentMessage } from "@trigger-helper/shared";
import { AGENT_A2, INST_A_ID, e2eInstances } from "./fixtures";
import { mockApiWithClose } from "./close-mock";

const TURNS = 14;
const FOCUS_OFFSET = 56;
const TOL = 120;

/** Тред с N ходами: высокие ассистент-баблы (обе колонки заведомо скроллятся). */
function lsThread(): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 1; i <= TURNS; i += 1) {
    out.push({
      id: `ls-q${i}`,
      role: "user",
      content: `ls-q${i}: вопрос хода ${i}`,
      createdAt: "2026-10-02T12:00:00.000Z",
    });
    out.push({
      id: `ls-a${i}`,
      role: "assistant",
      content: `ls-a${i}: ответ хода ${i}\n${"строка ответа, чтобы бабл был высоким\n".repeat(14)}`,
      createdAt: "2026-10-02T12:01:00.000Z",
    });
  }
  return out;
}

/** Одна сессия с одним rag_chat-агентом (AGENT_A2 — ключ треда базового мока). */
function lsInstances() {
  const a = e2eInstances().instances.find((i) => i.id === INST_A_ID)!.agents.find((x) => x.id === AGENT_A2)!;
  return {
    instances: [{ id: INST_A_ID, label: "Демо · скролл", createdAt: "2026-10-02T09:00:00.000Z", agents: [a] }],
    caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 1 },
  };
}

test.describe("linked scroll (P2, D-2)", () => {
  test.use({ viewport: { width: 1280, height: 460 } });

  test("лента ведёт трейс и трейс ведёт ленту: якорь на линии фокуса, .focused", async ({ page, context }) => {
    await mockApiWithClose(context, {
      instances: lsInstances(),
      extraThreads: { [`inst-a/${AGENT_A2}`]: lsThread() },
    });
    await page.emulateMedia({ reducedMotion: "reduce" }); // instant-скролл ведомого
    await page.goto("/");

    // лента и трейс восстановлены из треда, якоря data-turn-id на обеих сторонах
    await expect(page.locator(`.msg.bot[data-turn-id="ls-a${TURNS}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.trace .turn[data-turn-id="ls-a1"]')).toBeVisible();

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
    }, '[data-turn-id="ls-a3"]');
    const turn3 = page.locator('.trace .turn[data-turn-id="ls-a3"]');
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
    }, '[data-turn-id="ls-a6"]');
    const turn6 = page.locator('.trace .turn[data-turn-id="ls-a6"]');
    await expect(turn6).toHaveClass(/focused/, { timeout: 5_000 });
    const bubble6 = page.locator('.msg.bot[data-turn-id="ls-a6"]');
    await expect
      .poll(() => topDelta(bubble6, feed), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    expect(await topDelta(bubble6, feed)).toBeGreaterThanOrEqual(FOCUS_OFFSET - TOL);
  });

  test("клик по баблу и по ходу выравнивает обе колонки (Костя 04.10)", async ({ page, context }) => {
    await mockApiWithClose(context, {
      instances: lsInstances(),
      extraThreads: { [`inst-a/${AGENT_A2}`]: lsThread() },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(`.msg.bot[data-turn-id="ls-a${TURNS}"]`)).toBeVisible({ timeout: 10_000 });

    const feed = page.locator("[data-feed]");
    const trace = page.locator("[data-trace]");
    const topDelta = (anchor: ReturnType<typeof page.locator>, box: ReturnType<typeof page.locator>) =>
      Promise.all([anchor.boundingBox(), box.boundingBox()]).then(([ab, bb]) =>
        ab && bb ? ab.y - bb.y : null,
      );

    // — клик по ассистент-баблу хода 2: обе колонки ставят ход на линию фокуса —
    await page.locator('.msg.bot[data-turn-id="ls-a2"]').click();
    const turn2 = page.locator('.trace .turn[data-turn-id="ls-a2"]');
    const bubble2 = page.locator('.msg.bot[data-turn-id="ls-a2"]');
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
    await page.locator('.trace .turn[data-turn-id="ls-a10"] .tsummary').click();
    const turn10 = page.locator('.trace .turn[data-turn-id="ls-a10"]');
    const bubble10 = page.locator('.msg.bot[data-turn-id="ls-a10"]');
    await expect(turn10).toHaveClass(/focused/, { timeout: 5_000 });
    await expect
      .poll(() => topDelta(bubble10, feed), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
    await expect
      .poll(() => topDelta(turn10, trace), { timeout: 5_000 })
      .toBeLessThanOrEqual(FOCUS_OFFSET + TOL);
  });
});
