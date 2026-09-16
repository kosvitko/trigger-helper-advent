import type {
  AgentMemorySlice,
  FactRow,
  MemoryClassifyItem,
  MemoryLayer,
} from "@trigger-helper/shared";

function metaKey(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

function emptySlice(): AgentMemorySlice {
  return { facts: [], deleted: [] };
}

function normText(text: string): string {
  return text.trim().toLowerCase();
}

/** Token-set Jaccard — catches paraphrased duplicates ("не наклонять шею" /
 *  "шею не наклонять") that exact-text dedup misses. */
function similarFactText(a: string, b: string): boolean {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normText(text)
      .split(/[^0-9a-zа-яё]+/)
      .filter((t) => t.length > 1),
  );
}

export type MemoryStateOptions = {
  onChange?: () => void;
};

export type UpsertClassifyOptions = {
  /** Thread length at classify time — tombstones older than this are expired. */
  historySeq: number;
};

export type RemoveFactOptions = {
  historySeq: number;
  /** Classify sliding-window size; tombstone lives until the window slides past its source. */
  windowSize: number;
};

/**
 * Day11: layered fact registry (short / working / long).
 * One facts[] per agent; exclusivity via `layer` field.
 */
export class MemoryStateStore {
  private readonly byKey = new Map<string, AgentMemorySlice>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: MemoryStateOptions = {}) {
    this.onChange = opts.onChange;
  }

  get(instanceId: string, agentId: string): AgentMemorySlice {
    const slice = this.byKey.get(metaKey(instanceId, agentId));
    return slice
      ? {
          facts: slice.facts.map((f) => ({ ...f })),
          deleted: (slice.deleted ?? []).map((t) => ({ ...t })),
        }
      : emptySlice();
  }

  upsertFromClassify(
    instanceId: string,
    agentId: string,
    items: MemoryClassifyItem[],
    opts: UpsertClassifyOptions,
  ): AgentMemorySlice {
    const k = metaKey(instanceId, agentId);
    const prev = this.byKey.get(k) ?? emptySlice();
    // Tombstones expire once the classify window has slid past their source.
    const deleted = (prev.deleted ?? []).filter(
      (t) => t.untilSeq > opts.historySeq,
    );
    const facts = [...prev.facts];
    const now = new Date().toISOString();

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
          updatedAt: now,
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
          updatedAt: now,
        });
      }
    }

    const next = { facts, deleted };
    this.byKey.set(k, next);
    this.onChange?.();
    return { facts: facts.map((f) => ({ ...f })), deleted: deleted.map((t) => ({ ...t })) };
  }

  setLayer(
    instanceId: string,
    agentId: string,
    factId: string,
    layer: MemoryLayer,
  ): FactRow | null {
    const k = metaKey(instanceId, agentId);
    const slice = this.byKey.get(k);
    if (!slice) return null;
    const idx = slice.facts.findIndex((f) => f.id === factId);
    if (idx < 0) return null;
    const prev = slice.facts[idx]!;
    const updated: FactRow = {
      ...prev,
      layer,
      overridden: layer !== prev.suggestedLayer,
      updatedAt: new Date().toISOString(),
    };
    const facts = [...slice.facts];
    facts[idx] = updated;
    this.byKey.set(k, { facts, deleted: slice.deleted ?? [] });
    this.onChange?.();
    return { ...updated };
  }

  /** Day11 fix: delete + self-expiring tombstone (untilSeq = historySeq + windowSize). */
  removeFact(
    instanceId: string,
    agentId: string,
    factId: string,
    opts: RemoveFactOptions,
  ): boolean {
    const k = metaKey(instanceId, agentId);
    const slice = this.byKey.get(k);
    if (!slice) return false;
    const removed = slice.facts.find((f) => f.id === factId);
    if (!removed) return false;
    const facts = slice.facts.filter((f) => f.id !== factId);
    const deleted = [
      ...(slice.deleted ?? []).filter((t) => t.untilSeq > opts.historySeq),
      {
        norm: normText(removed.text),
        untilSeq: opts.historySeq + Math.max(0, opts.windowSize),
      },
    ];
    this.byKey.set(k, { facts, deleted });
    this.onChange?.();
    return true;
  }

  addManual(
    instanceId: string,
    agentId: string,
    text: string,
    layer: MemoryLayer = "working",
  ): FactRow {
    const k = metaKey(instanceId, agentId);
    const slice = this.byKey.get(k) ?? emptySlice();
    const row: FactRow = {
      id: crypto.randomUUID(),
      text: text.trim(),
      layer,
      suggestedLayer: layer,
      source: "manual",
      overridden: false,
      updatedAt: new Date().toISOString(),
    };
    const facts = [...slice.facts, row];
    this.byKey.set(k, { facts, deleted: slice.deleted ?? [] });
    this.onChange?.();
    return { ...row };
  }

  clearAgent(instanceId: string, agentId: string): void {
    this.byKey.delete(metaKey(instanceId, agentId));
    this.onChange?.();
  }

  snapshot(): Record<string, AgentMemorySlice> {
    return Object.fromEntries(
      [...this.byKey.entries()].map(([k, v]) => [
        k,
        {
          facts: v.facts.map((f) => ({ ...f })),
          deleted: (v.deleted ?? []).map((t) => ({ ...t })),
        },
      ]),
    );
  }

  load(map: Record<string, AgentMemorySlice> | undefined): void {
    this.byKey.clear();
    for (const [k, v] of Object.entries(map ?? {})) {
      this.byKey.set(k, {
        facts: Array.isArray(v.facts) ? v.facts.map((f) => ({ ...f })) : [],
        deleted: Array.isArray(v.deleted)
          ? v.deleted.map((t) => ({ ...t }))
          : [],
      });
    }
  }
}

export function createMemoryStateStore(
  opts?: MemoryStateOptions,
): MemoryStateStore {
  return new MemoryStateStore(opts);
}

/** Fail-open layer guess when LLM classify fails. */
export function heuristicSuggestedLayer(
  text: string,
  key?: string,
): MemoryLayer {
  const t = `${key ?? ""} ${text}`.toLowerCase();
  if (/огранич|нельзя|запрет|всегда|стиль|предпочит|профиль/.test(t)) {
    return "long";
  }
  if (/сейчас|точка|зона|техник|шаг|рабоч/.test(t)) {
    return "working";
  }
  return "short";
}
