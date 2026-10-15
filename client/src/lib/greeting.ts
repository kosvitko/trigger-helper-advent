/**
 * Приветствие при первом сообщении за местные сутки (Костя, 15.10):
 * флаг считает КЛИЕНТ — время пользователя, а не сервера. Применяется
 * в care/rag_chat/support (dev_help — внутренний ассистент, не здоровается).
 */

/** true, если пользовательских сообщений за сегодняшние местные сутки
 *  в ленте ещё не было (новый тред ⇒ тоже true — «новый участник»). */
export function isFirstLocalDayTurn(
  messages: { role: string; createdAt: string }[],
  now: Date = new Date(),
): boolean {
  const today = now.toDateString();
  return !messages.some(
    (m) =>
      m.role === "user" &&
      !Number.isNaN(Date.parse(m.createdAt)) &&
      new Date(m.createdAt).toDateString() === today,
  );
}

/** Местное время клиента «ЧЧ:ММ» (для приветствия по времени суток). */
export function localTimeHm(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getHours())}:${p(now.getMinutes())}`;
}
