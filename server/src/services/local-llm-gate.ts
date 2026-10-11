/**
 * День 30 (proposals 261011 §3.1-2 + cust-fix 11.10): семафор локальной
 * ветки — один слот по умолчанию (= OLLAMA_NUM_PARALLEL=1). Ждущие получают
 * позицию при постановке и при каждом сдвиге очереди (onQueued снова).
 */

export type LocalLlmGateSnapshot = {
  inflight: number;
  waiting: number;
  max: number;
};

export type LocalLlmGate = {
  snapshot(): LocalLlmGateSnapshot;
  /**
   * Занять слот. Если слотов нет — `onQueued(position)` сразу и при каждом
   * сдвиге очереди (1-based). Возвращает `release` (ровно один раз в finally).
   */
  acquire(
    onQueued?: (position: number, snap: LocalLlmGateSnapshot) => void,
  ): Promise<() => void>;
};

type Waiter = {
  wake: () => void;
  notify: (position: number, snap: LocalLlmGateSnapshot) => void;
};

export function createLocalLlmGate(maxConcurrent = 1): LocalLlmGate {
  const max = Math.max(1, Math.floor(maxConcurrent));
  let inflight = 0;
  const waiters: Waiter[] = [];

  const snapshot = (): LocalLlmGateSnapshot => ({
    inflight,
    waiting: waiters.length,
    max,
  });

  const notifyWaiting = (): void => {
    const snap = snapshot();
    waiters.forEach((w, i) => w.notify(i + 1, snap));
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      // Сначала обновить позиции оставшихся (2→1, 3→2…), потом разбудить
      // голову — иначе UI на миг видит чужой индекс.
      notifyWaiting();
      next.wake();
    } else {
      inflight = Math.max(0, inflight - 1);
    }
  };

  return {
    snapshot,
    async acquire(onQueued) {
      if (inflight < max) {
        inflight += 1;
        return release;
      }
      await new Promise<void>((resolve) => {
        const waiter: Waiter = {
          wake: resolve,
          notify: (pos, snap) => onQueued?.(pos, snap),
        };
        waiters.push(waiter);
        onQueued?.(waiters.length, snapshot());
      });
      // Слот уже «наш» после transfer от release предыдущего владельца.
      return release;
    },
  };
}

/** Процесс-синглтон для /api/chat + /api/health (инициализация — boot). */
let shared: LocalLlmGate | null = null;

/** Вызвать один раз при старте сервера (env.LOCAL_MAX_CONCURRENT ?? 1). */
export function initLocalLlmGate(maxConcurrent = 1): LocalLlmGate {
  shared = createLocalLlmGate(maxConcurrent);
  return shared;
}

export function getLocalLlmGate(): LocalLlmGate {
  if (!shared) shared = createLocalLlmGate(1);
  return shared;
}

/** Только юнит-тесты — сброс синглтона между кейсами. */
export function resetLocalLlmGateForTests(): void {
  shared = null;
}
