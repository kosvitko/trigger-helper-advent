// Сетап юнит-тестов (vitest + happy-dom): точечные гард-полифиллы окружения
// и чистое состояние между тестами. Ничего продуктового здесь нет.
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, vi } from "vitest";

// api.ts вызывает AbortSignal.timeout(ms) ДО fetch. В тестовом окружении
// метода может не быть; fetch всегда замокан, сигнал никогда не абортится —
// достаточно невалидного (никогда не срабатывающего) сигнала.
if (typeof AbortSignal.timeout !== "function") {
  Object.assign(AbortSignal, {
    timeout: () => new AbortController().signal,
  });
}

// dialog.send генерирует local-ид через crypto.randomUUID().
if (typeof globalThis.crypto?.randomUUID !== "function") {
  Object.defineProperty(globalThis, "crypto", {
    value: { ...globalThis.crypto, randomUUID },
    configurable: true,
  });
}

// Хранилища сторов (th.trace.v1:<threadId>, th.overrides.v1, th.active.v1)
// — чистый лист перед каждым тестом, чтобы кэш-тесты не влияли друг на
// друга. Коллекции th-local чистятся сами (replaceAll) — их тесты
// управляют порядком записей.
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
