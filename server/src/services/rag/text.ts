/**
 * Day24 (design D-3, Δ-1): общий нормализатор русского текста — перенос из
 * eval-rag-answer.ts:87–94 без изменения логики; оба потребителя (серверная
 * верификация цитат в answer.ts, метрики eval) импортируют его отсюда.
 * Без зависимостей.
 */

/** lowercase · ё→е · пунктуация → пробел · `\s+` → один пробел · trim. */
export function normalizeRu(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
