// Форматирование чисел трейса/диалога — телеметрия уходит в трейс (D-3).

/** 9700 → «9.7k» */
export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 0.42 → «₽0.42» */
export function fmtRub(n: number): string {
  return `₽${n.toFixed(2)}`;
}

/** 14200 мс → «14.2 s» */
export function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Русская плюрализация: plural(4, "ход", "хода", "ходов") → «хода». */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
