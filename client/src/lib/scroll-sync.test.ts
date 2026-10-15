/**
 * UNIT — связный скролл диалог ↔ трейс (scroll-sync.ts, P2/D-2):
 * середина ленты — якорь на линии фокуса; лидер, прижатый к низу, ведёт
 * ведомого к последнему ходу (репорт 261015: длинный support-чат, Enter
 * без мыши — трейс прилипал к старому ходу «вторым сверху» и отматывал
 * за собой диалог); программный скролл ведомого под guard — без пинг-понга.
 * Геометрия — стабы getBoundingClientRect/scrollTo (happy-dom не лэйаутит).
 */
import { describe, expect, it, vi } from "vitest";
import { linkScroll } from "./scroll-sync";

interface Box {
  top: number;
  bottom: number;
}

/** Viewport-прямоугольник элемента (как в браузере при текущем скролле). */
function stubRect(el: HTMLElement, box: Box): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: box.top,
    bottom: box.bottom,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Скролл-геометрия контейнера + перехват scrollTo с записью вызовов. */
function stubScroll(
  el: HTMLElement,
  geom: { scrollTop: number; clientHeight: number; scrollHeight: number },
): ScrollToOptions[] {
  const calls: ScrollToOptions[] = [];
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geom.scrollTop,
    set: (v: number) => {
      geom.scrollTop = v;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => geom.clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => geom.scrollHeight,
  });
  const scrollTo: (t?: number | ScrollToOptions) => void = (t) => {
    const opts = typeof t === "number" ? { top: t } : (t ?? {});
    calls.push(opts);
    geom.scrollTop = opts.top ?? geom.scrollTop;
  };
  Object.defineProperty(el, "scrollTo", { configurable: true, value: scrollTo });
  return calls;
}

/** Колонка с якорями data-turn-id (сверху вниз по порядку массива). */
function makeColumn(boxes: ({ id: string } & Box)[]): {
  el: HTMLDivElement;
} {
  const el = document.createElement("div");
  for (const { id, top, bottom } of boxes) {
    const a = document.createElement("div");
    a.dataset.turnId = id;
    stubRect(a, { top, bottom });
    el.appendChild(a);
  }
  stubRect(el, { top: 0, bottom: 600 }); // контейнер: линия фокуса = 56px
  return { el };
}

describe("linkScroll — связный скролл (P2, D-2)", () => {
  it("лидер прижат к низу — ведомый к последнему ходу, не к якорю линии (репорт 261015)", () => {
    // Лента в конце длинного чата: линия фокуса (56px) пересекает старый
    // бабл t3; свежий ход t7 — ниже вьюпорта (лента стоит на «хвосте»).
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t3", top: 40, bottom: 520 }, // пересекает линию — прежний (баговый) выбор
      { id: "t7", top: 620, bottom: 1500 }, // последний ход, ниже видимой части
    ]);
    const trace = makeColumn([
      { id: "t1", top: 0, bottom: 100 },
      { id: "t3", top: 200, bottom: 320 },
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const feedCalls = stubScroll(feed.el, { scrollTop: 800, clientHeight: 600, scrollHeight: 1400 }); // 800+600=1400 — прижат
    const traceCalls = stubScroll(trace.el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 });
    const focus: (string | null)[] = [];
    linkScroll(feed.el, trace.el, { onTurnFocus: (id) => focus.push(id) });

    feed.el.dispatchEvent(new Event("scroll"));

    // трейс — к последнему ходу t7 на линию фокуса: 0 + (500 − 0) − 56 = 444
    expect(traceCalls.map((c) => c.top)).toEqual([444]);
    expect(feedCalls).toHaveLength(0); // лидера не трогаем
    expect(focus.at(-1)).toBe("t7");
  });

  it("лидер в середине ленты — прежний контракт: якорь линии фокуса", () => {
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t2", top: -80, bottom: 300 }, // пересекает линию 56px
      { id: "t7", top: 620, bottom: 1500 },
    ]);
    const trace = makeColumn([
      { id: "t1", top: 0, bottom: 100 },
      { id: "t2", top: 200, bottom: 320 },
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const traceCalls = stubScroll(trace.el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 });
    stubScroll(feed.el, { scrollTop: 100, clientHeight: 600, scrollHeight: 1400 }); // 700 < 1398 — не прижат
    const focus: (string | null)[] = [];
    linkScroll(feed.el, trace.el, { onTurnFocus: (id) => focus.push(id) });

    feed.el.dispatchEvent(new Event("scroll"));

    expect(traceCalls.map((c) => c.top)).toEqual([144]); // t2: 200 − 56
    expect(focus.at(-1)).toBe("t2");
  });

  it("программный скролл ведомого под guard — не становится лидером (без пинг-понга)", () => {
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t3", top: 40, bottom: 520 },
      { id: "t7", top: 620, bottom: 1500 },
    ]);
    const trace = makeColumn([
      { id: "t1", top: 0, bottom: 100 },
      { id: "t3", top: 200, bottom: 320 },
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const feedCalls = stubScroll(feed.el, { scrollTop: 800, clientHeight: 600, scrollHeight: 1400 });
    stubScroll(trace.el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 });
    linkScroll(feed.el, trace.el);

    feed.el.dispatchEvent(new Event("scroll")); // трейс программно уехал к t7, guard поставлен
    trace.el.dispatchEvent(new Event("scroll")); // его скролл-событие — не лидер

    expect(feedCalls).toHaveLength(0);
  });

  it("scrollend лидера не снимает guard ведомого (корень 261015: эхо отматывало ленту)", () => {
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t3", top: 40, bottom: 520 },
      { id: "t7", top: 620, bottom: 1500 },
    ]);
    const trace = makeColumn([
      { id: "t1", top: 0, bottom: 100 },
      { id: "t3", top: 200, bottom: 320 },
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const feedCalls = stubScroll(feed.el, { scrollTop: 800, clientHeight: 600, scrollHeight: 1400 });
    stubScroll(trace.el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 });
    linkScroll(feed.el, trace.el);

    // автоскролл ленты (лидер) → трейс программно уехал к t7; у лидера своё
    // scrollend (свой автоскролл закончился) — оно НЕ должно открывать эхо трейса
    feed.el.dispatchEvent(new Event("scroll"));
    feed.el.dispatchEvent(new Event("scrollend"));
    trace.el.dispatchEvent(new Event("scroll")); // эхо трейса — не лидер

    expect(feedCalls).toHaveLength(0);
  });

  it("прижатый лидер, у ведомого нет ходов — без скролла, фокус сброшен", () => {
    const feed = makeColumn([{ id: "t1", top: 40, bottom: 520 }]);
    const trace = makeColumn([]); // трейс пуст (ранний чат)
    const traceCalls = stubScroll(trace.el, { scrollTop: 0, clientHeight: 600, scrollHeight: 0 });
    stubScroll(feed.el, { scrollTop: 800, clientHeight: 600, scrollHeight: 1400 });
    const focus: (string | null)[] = [];
    linkScroll(feed.el, trace.el, { onTurnFocus: (id) => focus.push(id) });

    feed.el.dispatchEvent(new Event("scroll"));

    expect(traceCalls).toHaveLength(0);
    expect(focus.at(-1)).toBeNull();
  });

  it("трейс без интента — layout-скачок не ведёт ленту (репорт 261015-2)", () => {
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t2", top: 40, bottom: 500 },
      { id: "t7", top: 620, bottom: 1500 },
    ]);
    const trace = makeColumn([
      { id: "t1", top: -200, bottom: 20 },
      { id: "t2", top: -80, bottom: 300 },
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const feedCalls = stubScroll(feed.el, { scrollTop: 100, clientHeight: 600, scrollHeight: 1400 });
    stubScroll(trace.el, { scrollTop: 300, clientHeight: 600, scrollHeight: 2000 });
    linkScroll(feed.el, trace.el);

    // layout-скачок трейса (схлопывание ходов/anchoring) — без жеста пользователя
    trace.el.dispatchEvent(new Event("scroll"));

    expect(feedCalls).toHaveLength(0);
  });

  it("трейс с живым интентом (wheel) — ведёт ленту якорем линии фокуса", () => {
    const feed = makeColumn([
      { id: "t1", top: -300, bottom: -200 },
      { id: "t2", top: 40, bottom: 500 },
      { id: "t7", top: 620, bottom: 1500 },
    ]);
    const trace = makeColumn([
      { id: "t1", top: -200, bottom: 20 },
      { id: "t2", top: -80, bottom: 300 }, // пересекает линию 56px трейса
      { id: "t7", top: 500, bottom: 900 },
    ]);
    const feedCalls = stubScroll(feed.el, { scrollTop: 100, clientHeight: 600, scrollHeight: 1400 });
    stubScroll(trace.el, { scrollTop: 300, clientHeight: 600, scrollHeight: 2000 });
    linkScroll(feed.el, trace.el);

    trace.el.dispatchEvent(new Event("wheel")); // жест пользователя
    trace.el.dispatchEvent(new Event("scroll"));

    // лента — бабл t2 на линию: 100 + (40 − 0) − 56 = 84
    expect(feedCalls.map((c) => c.top)).toEqual([84]);
  });
});
