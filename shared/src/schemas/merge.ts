import type {
  ChatTaskState,
  FactRow,
  FactTombstone,
  MemoryClassifyItem,
} from "./agent.js";

/**
 * C+ (CH-5b, D-4/Q-3): merge memoryDelta на клиенте. Дословный перенос
 * серверных алгоритмов day11/day25 (memory-state.ts upsertFromClassify,
 * chat-task-state.ts upsertExtracted) в чистые функции — один источник:
 * сервер больше не хранит память, клиент мержит дельту хода локально.
 */

// --- day11: факты (Jaccard ≥ 0.7 по полным токенам) ------------------------

function normText(text: string): string {
  return text.trim().toLowerCase();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normText(text)
      .split(/[^0-9a-zа-яё]+/)
      .filter((t) => t.length > 1),
  );
}

/** Token-set Jaccard — catches paraphrased duplicates ("не наклонять шею" /
 *  "шею не наклонять") that exact-text dedup misses. */
export function similarFactText(a: string, b: string): boolean {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

export type MergeFactDeltaResult = {
  facts: FactRow[];
  /** Живые tombstones (протухшие отфильтрованы по historySeq). */
  deleted: FactTombstone[];
};

/**
 * Stateless-экстракт → дельта фактов (day11 upsertFromClassify):
 * - tombstone истекает, когда classify-окно проскользнуло источник
 *   (untilSeq > historySeq; на клиенте historySeq = длина локального
 *   диалога в момент хода);
 * - матч: key → точный текст → Jaccard 0.7;
 * - слой: ручной override/перенос сохраняются (keepLayer), иначе
 *   suggested; suppressed-текст не добавляется.
 */
export function mergeFactDelta(
  prev: readonly FactRow[],
  items: readonly MemoryClassifyItem[],
  opts: { historySeq: number; deleted?: readonly FactTombstone[] },
  now: () => string = () => new Date().toISOString(),
): MergeFactDeltaResult {
  const deleted = (opts.deleted ?? []).filter(
    (t) => t.untilSeq > opts.historySeq,
  );
  const facts = [...prev];
  const isSuppressed = (text: string) =>
    deleted.some(
      (t) => t.norm === normText(text) || similarFactText(t.norm, text),
    );

  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const suggested = item.suggestedLayer;
    const key = item.key?.trim() || undefined;
    let idx = facts.findIndex((f) =>
      key
        ? f.key === key
        : normText(f.text) === normText(text),
    );
    if (idx < 0) {
      idx = facts.findIndex((f) => similarFactText(f.text, text));
    }

    if (idx >= 0) {
      const prevFact = facts[idx]!;
      const keepLayer =
        prevFact.overridden === true ||
        prevFact.layer !== prevFact.suggestedLayer;
      const layer = keepLayer ? prevFact.layer : suggested;
      facts[idx] = {
        ...prevFact,
        text,
        ...(key ? { key } : {}),
        suggestedLayer: suggested,
        layer,
        overridden: layer !== suggested,
        updatedAt: now(),
        source: "classify",
      };
    } else if (isSuppressed(text)) {
      continue;
    } else {
      facts.push({
        id: crypto.randomUUID(),
        text,
        ...(key ? { key } : {}),
        layer: suggested,
        suggestedLayer: suggested,
        source: "classify",
        overridden: false,
        updatedAt: now(),
      });
    }
  }
  return { facts, deleted };
}

// --- day25: память задачи (Jaccard 0.7 по 3-символьным префиксам) ----------

function chatTaskTokenSet(text: string): Set<string> {
  // парафразы ловит промпт-слой («Уже в памяти»), это — лексическая страховка.
  return new Set(
    text
      .trim()
      .toLowerCase()
      .split(/[^0-9a-zа-яё]+/)
      .filter((t) => t.length > 1)
      .map((t) => (t.length >= 4 ? t.slice(0, 3) : t)),
  );
}

function similarChatTaskText(a: string, b: string): boolean {
  const sa = chatTaskTokenSet(a);
  const sb = chatTaskTokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

function clipItem(text: string, cap: number): string {
  const t = text.trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** Дедуп-слияние списков (Jaccard 0.7), кап длины — как в памяти слоёв. */
function mergeList(existing: string[], incoming: string[], cap: number): string[] {
  const out = [...existing];
  for (const raw of incoming) {
    const item = clipItem(raw, 160);
    if (!item) continue;
    if (out.some((t) => t === item || similarChatTaskText(t, item))) continue;
    out.push(item);
    if (out.length >= cap) break;
  }
  return out.slice(-cap);
}

/** Экстракт хода → память задачи (day25 upsertExtracted, stateless). */
export function mergeChatTaskDelta(
  prev: ChatTaskState,
  extracted: {
    goal?: string;
    clarified?: string[];
    constraints_terms?: string[];
  },
): ChatTaskState {
  const goal = extracted.goal?.trim();
  return {
    goal: goal ? clipItem(goal, 300) : prev.goal,
    clarified: mergeList(prev.clarified, extracted.clarified ?? [], 8),
    constraints_terms: mergeList(
      prev.constraints_terms,
      extracted.constraints_terms ?? [],
      8,
    ),
  };
}

// --- day09: триггер инлайн-сжатия (клиентский, Q-2) -------------------------

/** keepLast как в серверном COMPRESS_KEEP_LAST (llm-agent). */
export const CHAT_COMPRESS_KEEP_LAST = 4;
/** Дефолт сервера AGENT_COMPRESS_EVERY (day09) — теперь настройка клиента. */
export const CHAT_COMPRESS_EVERY_DEFAULT = 10;

/**
 * Триггер сжатия на клиенте (day09 shouldAutoCompress, адаптирован под
 * ChatThreadRecord: summaries — отдельный массив, значит dialogue[] — это
 * весь хвост после последней сводки по построению). Считаем только то, что
 * пойдёт в сводку: диалог минус keepLast-хвост.
 */
export function shouldCompressChatTail(
  dialogueCount: number,
  every: number,
  keepLast: number = CHAT_COMPRESS_KEEP_LAST,
): boolean {
  if (!(every > 0)) return false;
  return dialogueCount - keepLast >= every;
}
