/**
 * P2: связный скролл диалог ↔ трейс (D-2, требование Кости дословно:
 * «чтобы ответы пользователю и трейсы были синхронизированы»).
 * Leader-by-intent: ведёт та колонка, которую скроллит пользователь;
 * программный скролл ведомого прикрыт guard-флагом (scrollend/hard-cap),
 * чтобы не было ping-pong. Якорь пары — data-turn-id (бабл ↔ блок хода).
 */

export interface ScrollSyncOptions {
  /** Отступ «линии фокуса» от верха колонки. */
  offsetPx?: number;
  /** Ход, встал на линию фокуса (индикатор «ход в фокусе»). */
  onTurnFocus?: (turnId: string | null) => void;
}

/** Hard-cap guard: даже без scrollend программная анимация не длиннее. */
const HARD_GUARD_MS = 800;

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

export function linkScroll(
  a: HTMLElement,
  b: HTMLElement,
  opts: ScrollSyncOptions = {},
): { dispose: () => void; alignTo: (turnId: string) => void } {
  const offsetPx = opts.offsetPx ?? 56;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let guardUntil = 0;
  let disposed = false;

  /** Прокрутить контейнер так, чтобы якорь хода встал на линию фокуса. */
  const scrollToAnchor = (container: HTMLElement, el: HTMLElement): void => {
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const top = container.scrollTop + (er.top - cr.top) - offsetPx;
    guardUntil = performance.now() + HARD_GUARD_MS;
    container.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  };

  const follow = (leader: HTMLElement, follower: HTMLElement): void => {
    if (performance.now() < guardUntil) return; // это наш программный скролл
    const anchor = anchorAtLine(leader, offsetPx);
    const turnId = anchor?.dataset.turnId ?? null;
    opts.onTurnFocus?.(turnId);
    if (!anchor || !turnId) return;
    const target = anchors(follower).find((el) => el.dataset.turnId === turnId);
    if (!target) return;
    scrollToAnchor(follower, target);
  };

  const onA = (): void => {
    if (!disposed) follow(a, b);
  };
  const onB = (): void => {
    if (!disposed) follow(b, a);
  };
  const clearGuard = (): void => {
    guardUntil = 0;
  };

  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  a.addEventListener("scrollend", clearGuard);
  b.addEventListener("scrollend", clearGuard);

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
    a.removeEventListener("scrollend", clearGuard);
    b.removeEventListener("scrollend", clearGuard);
  };

  return { dispose, alignTo };
}
