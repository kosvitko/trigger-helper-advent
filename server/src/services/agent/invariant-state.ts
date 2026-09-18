import type {
  InvariantCreate,
  InvariantPatch,
  InvariantRow,
  InvariantState,
  TaskState,
} from "@trigger-helper/shared";

export type InvariantStateOptions = {
  onChange?: () => void;
};

/** Day14 D-3: кап списка инвариантов (превышение → 409 наружу). */
export const INVARIANT_CAP = 8;

function keyOf(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

function emptyState(): InvariantState {
  return { invariants: [] };
}

/**
 * Day14 D-8: seed 6 правил владельца — домен (медикаменты/диагнозы, красные
 * флаги), стек/архитектура продукта, стиль (транслитерация — пример орга из
 * чата 17.09), процесс задачи. Consent-инвариант — структурный (гвард FSM),
 * рядом не сидируется. Тексты ≤70 симв. — читаются в кадре и в note.
 */
const SEED_INVARIANTS: InvariantCreate[] = [
  {
    text: "Без медикаментов и диагнозов — только самомассаж и разминка",
    scope: "agent",
    enforcement: "hard",
    pattern: "таблетк|лекарств|медикамент|диагноз",
  },
  {
    text: "Онемение или острая боль — стоп и к специалисту",
    scope: "agent",
    enforcement: "hard",
    pattern: "онемен|острая боль|острую боль",
  },
  {
    text: "Стек продукта: UI — один HTML-файл, данные — JSON без БД",
    scope: "agent",
    enforcement: "hard",
    pattern: "svelte|react|postgres|mongodb",
  },
  {
    text: "Английские термины — латиницей, без транслитерации",
    scope: "agent",
    enforcement: "soft",
  },
  {
    text: "Не выходить за план задачи — новое в новую задачу",
    scope: "task",
    enforcement: "hard",
  },
  {
    text: "Один шаг за раз — шаги плана не перескакивать",
    scope: "task",
    enforcement: "soft",
  },
];

function seedState(): InvariantState {
  const now = new Date().toISOString();
  return {
    invariants: SEED_INVARIANTS.map((s) => ({
      id: crypto.randomUUID(),
      text: s.text,
      scope: s.scope,
      enforcement: s.enforcement,
      ...(s.pattern !== undefined ? { pattern: s.pattern } : {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

/**
 * Day14 D-1: agent-level invariants — key `instanceId|agentId` (зеркало
 * taskStates). get()/getActive() чистые; seeding — только ensureSeed() из
 * GET-роута; onChange — только при фактической записи (паттерн day12/13).
 */
export class InvariantStateStore {
  private readonly byKey = new Map<string, InvariantState>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: InvariantStateOptions = {}) {
    this.onChange = opts.onChange;
  }

  get(instanceId: string, agentId: string): InvariantState {
    const state = this.byKey.get(keyOf(instanceId, agentId)) ?? emptyState();
    return { invariants: state.invariants.map((row) => ({ ...row })) };
  }

  /** Day14 D-5: agent-ряды (active) всегда; task-ряды (active) — при активной
   *  задаче (stage != done; пауза задачу не завершает). [INV-n] = позиция. */
  getActive(
    instanceId: string,
    agentId: string,
    taskState?: TaskState | null,
  ): InvariantRow[] {
    const state = this.byKey.get(keyOf(instanceId, agentId));
    if (!state) return [];
    const taskAlive = Boolean(taskState && taskState.stage !== "done");
    return state.invariants
      .filter((row) => row.active && (row.scope === "agent" || taskAlive))
      .map((row) => ({ ...row }));
  }

  /** Seed-once для нового ключа; опустошённый стор остаётся пустым. */
  ensureSeed(instanceId: string, agentId: string): InvariantState {
    const key = keyOf(instanceId, agentId);
    if (!this.byKey.has(key)) {
      this.byKey.set(key, seedState());
      this.onChange?.();
    }
    return this.get(instanceId, agentId);
  }

  create(instanceId: string, agentId: string, data: InvariantCreate): InvariantRow | "cap" {
    const key = keyOf(instanceId, agentId);
    const prev = this.byKey.get(key) ?? emptyState();
    if (prev.invariants.length >= INVARIANT_CAP) return "cap";
    const now = new Date().toISOString();
    const row: InvariantRow = {
      id: crypto.randomUUID(),
      text: data.text,
      scope: data.scope,
      enforcement: data.enforcement,
      ...(data.pattern !== undefined ? { pattern: data.pattern } : {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.byKey.set(key, { invariants: [...prev.invariants, row] });
    this.onChange?.();
    return { ...row };
  }

  /** PATCH: absent = keep; pattern: строка = заменить, null = убрать.
   *  Гвард «hard→soft при живом pattern» — в роуте (нужен текущий ряд). */
  update(
    instanceId: string,
    agentId: string,
    invariantId: string,
    patch: InvariantPatch,
  ): InvariantRow | null {
    const key = keyOf(instanceId, agentId);
    const state = this.byKey.get(key);
    if (!state) return null;
    const idx = state.invariants.findIndex((row) => row.id === invariantId);
    if (idx < 0) return null;
    const prev = state.invariants[idx]!;
    const next: InvariantRow = {
      ...prev,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.enforcement !== undefined ? { enforcement: patch.enforcement } : {}),
      ...(patch.pattern !== undefined
        ? patch.pattern === null
          ? { pattern: undefined }
          : { pattern: patch.pattern }
        : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedAt: new Date().toISOString(),
    };
    const invariants = [...state.invariants];
    invariants[idx] = next;
    this.byKey.set(key, { invariants });
    this.onChange?.();
    return { ...next };
  }

  remove(instanceId: string, agentId: string, invariantId: string): boolean {
    const key = keyOf(instanceId, agentId);
    const state = this.byKey.get(key);
    if (!state || !state.invariants.some((row) => row.id === invariantId)) {
      return false;
    }
    this.byKey.set(key, {
      invariants: state.invariants.filter((row) => row.id !== invariantId),
    });
    this.onChange?.();
    return true;
  }

  clearAgent(instanceId: string, agentId: string): void {
    if (this.byKey.delete(keyOf(instanceId, agentId))) this.onChange?.();
  }

  snapshot(): Record<string, InvariantState> {
    return Object.fromEntries(
      [...this.byKey.entries()].map(([k, v]) => [
        k,
        { invariants: v.invariants.map((row) => ({ ...row })) },
      ]),
    );
  }

  load(map: Record<string, InvariantState> | undefined): void {
    this.byKey.clear();
    for (const [k, v] of Object.entries(map ?? {})) {
      this.byKey.set(k, {
        invariants: Array.isArray(v.invariants)
          ? v.invariants.map((row) => ({ ...row }))
          : [],
      });
    }
  }
}

export function createInvariantStateStore(
  opts?: InvariantStateOptions,
): InvariantStateStore {
  return new InvariantStateStore(opts);
}
