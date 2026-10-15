/**
 * P2: связный скролл диалог ↔ трейс (D-2, требование Кости дословно:
 * «чтобы ответы пользователю и трейсы были синхронизированы»).
 * Leader-by-intent: ведёт та колонка, которую скроллит пользователь;
 * программный скролл ведомого прикрыт guard-флагом (scrollend/hard-cap),
 * чтобы не было ping-pong. Якорь пары — data-turn-id (бабл ↔ блок хода).
 *
 * Грабли 261015 (support-чат, репорт Кости): guard был один на пару, и
 * scrollend автоскролла ЛИДЕРА мгновенно снимал прикрытие только что
 * прокрученного ведомого — эхо трейса становилось «лидером» и отматывало
 * ленту к старому ходу на каждый Enter. Guard теперь персональный
 * (scrollend колонки снимает только её собственный), плюс прижатый к низу
 * лидер синхронизирует «хвост к хвосту» — последним ходом, а не якорем
 * линии фокуса (у нижнего края длинного чата там стоит старый бабл).
 *
 * Репорт 261015-2 (чтение истории через трейс + отправка): layout-скачки
 * трейса (схлопывание ходов, scroll-anchoring) вели ленту и дёргали её
 * вниз-обратно. Трейс ведёт теперь только при живом интенте пользователя
 * (wheel/скроллбар/клавиши/тач); лента ведёт без условия — её автоскролл
 * хвоста (новое сообщение) — смысловой сигнал синхронизации.
 */

export interface ScrollSyncOptions {
  /** Отступ «линии фокуса» от верха колонки. */
  offsetPx?: number;
  /** Ход, встал на линию фокуса (индикатор «ход в фокусе»). */
  onTurnFocus?: (turnId: string | null) => void;
}

/** Hard-cap guard: даже без scrollend программная анимация не длиннее. */
const HARD_GUARD_MS = 800;

/** Допуск «прижат к низу» (субпиксельная арифметика высот). */
const BOTTOM_EPS_PX = 2;

function anchors(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("[data-turn-id]"));
}

/** Якорь на линии фокуса: первый элемент, чей низ ниже линии; ниже всех — последний. */
function anchorAtLine(container: HTMLElement, offsetPx: number): HTMLElement | null {
  const line = container.getBoundingClientRect().top + offsetPx;
  const list = anchors(container);
  for (const el of list) {
    if (el.getBoundingClientRect().bottom >= line) return el;
  }
  return list[list.length - 1] ?? null;
}

/** Колонка прижата к низу: лента в состоянии «читаю хвост» — автоскролл
 *  нового сообщения (DialogColumn) или ручной скролл в конец. */
function pinnedToBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_EPS_PX;
}

export function linkScroll(
  a: HTMLElement,
  b: HTMLElement,
  opts: ScrollSyncOptions = {},
): { dispose: () => void; alignTo: (turnId: string) => void } {
  const offsetPx = opts.offsetPx ?? 56;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Guard программного скролла — НА КОЛОНКУ: scrollend лидера не должен
   *  снимать прикрытие эха ведомого (грабля 261015). */
  const guardUntil = new WeakMap<HTMLElement, number>();
  const guarded = (el: HTMLElement): boolean => performance.now() < (guardUntil.get(el) ?? 0);
  /** Живой интент на ТРЕЙСЕ (wheel/скроллбар/клавиши/тач): без него скролл-
   *  события трейса — layout-шум, не лидер (репорт 261015-2). Окно держит
   *  связку «жест → скролл-событие»; тач-инерция после touchend на десктоп-
   *  продукте не кейс. */
  const INTENT_WINDOW_MS = 250;
  const intentAt = new WeakMap<HTMLElement, number>();
  const markIntent = (): void => {
    intentAt.set(b, performance.now());
  };
  const traceHasIntent = (): boolean =>
    performance.now() - (intentAt.get(b) ?? Number.NEGATIVE_INFINITY) < INTENT_WINDOW_MS;
  const onTraceWheel = (): void => markIntent();
  const onTracePointer = (e: PointerEvent): void => {
    if (e.type === "pointerdown" || e.buttons > 0) markIntent();
  };
  const onTraceTouch = (): void => markIntent();
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const onTraceKeys = (e: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(e.key)) markIntent();
  };
  let disposed = false;

  /** Прокрутить контейнер так, чтобы якорь хода встал на линию фокуса. */
  const scrollToAnchor = (container: HTMLElement, el: HTMLElement): void => {
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const top = container.scrollTop + (er.top - cr.top) - offsetPx;
    guardUntil.set(container, performance.now() + HARD_GUARD_MS);
    container.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  };

  const follow = (leader: HTMLElement, follower: HTMLElement, leaderIsTrace: boolean): void => {
    if (guarded(leader)) return; // это эхо нашего программного скролла
    // Трейс без живого интента — layout-скачок (схлопывание/anchoring),
    // не лидер; лента ведёт всегда (её автоскролл хвоста — сигнал).
    if (leaderIsTrace && !traceHasIntent()) return;
    // Хвост синхронизируем хвостом: прижатый к низу лидер ведёт ведомого к
    // ПОСЛЕДНЕМУ ходу; в середине — прежний контракт «якорь на линии фокуса».
    const followerAnchors = anchors(follower);
    const anchor = pinnedToBottom(leader)
      ? (followerAnchors[followerAnchors.length - 1] ?? null)
      : anchorAtLine(leader, offsetPx);
    const turnId = anchor?.dataset.turnId ?? null;
    opts.onTurnFocus?.(turnId);
    if (!anchor || !turnId) return;
    const target = followerAnchors.find((el) => el.dataset.turnId === turnId);
    if (!target) return;
    scrollToAnchor(follower, target);
  };

  const onA = (): void => {
    if (!disposed) follow(a, b, false);
  };
  const onB = (): void => {
    if (!disposed) follow(b, a, true);
  };
  const clearGuardA = (): void => {
    guardUntil.delete(a);
  };
  const clearGuardB = (): void => {
    guardUntil.delete(b);
  };

  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  a.addEventListener("scrollend", clearGuardA);
  b.addEventListener("scrollend", clearGuardB);
  // Интент-маркеры трейса: wheel/скроллбар (pointer)/клавиши/тач.
  b.addEventListener("wheel", onTraceWheel, { passive: true });
  b.addEventListener("pointerdown", onTracePointer, { passive: true });
  b.addEventListener("pointermove", onTracePointer, { passive: true });
  b.addEventListener("touchmove", onTraceTouch, { passive: true });
  b.addEventListener("keydown", onTraceKeys);

  /** Кликовая синхронизация (Костя 04.10): клик по ходу/баблу — обе колонки
   *  ставят этот ход на линию фокуса (недостающий якорь пропускается). */
  const alignTo = (turnId: string): void => {
    if (disposed) return;
    const aAnchor = anchors(a).find((el) => el.dataset.turnId === turnId);
    const bAnchor = anchors(b).find((el) => el.dataset.turnId === turnId);
    if (aAnchor) scrollToAnchor(a, aAnchor);
    if (bAnchor) setTimeout(() => !disposed && scrollToAnchor(b, bAnchor), 40);
    opts.onTurnFocus?.(turnId);
  };

  const dispose = (): void => {
    disposed = true;
    a.removeEventListener("scroll", onA);
    b.removeEventListener("scroll", onB);
    a.removeEventListener("scrollend", clearGuardA);
    b.removeEventListener("scrollend", clearGuardB);
    b.removeEventListener("wheel", onTraceWheel);
    b.removeEventListener("pointerdown", onTracePointer);
    b.removeEventListener("pointermove", onTracePointer);
    b.removeEventListener("touchmove", onTraceTouch);
    b.removeEventListener("keydown", onTraceKeys);
  };

  return { dispose, alignTo };
}
