import type {
  TaskCreate,
  TaskPatch,
  TaskStage,
  TaskState,
  TaskTransition,
} from "@trigger-helper/shared";

export type TaskStateOptions = {
  onChange?: () => void;
};

/**
 * Day13 D-2: canonical transitions (лекция недели 3 — 4 этапа не уменьшать;
 * done терминальная). Единственный источник переходов — код, не промпт.
 */
export const ALLOWED_TRANSITIONS: Record<TaskStage, TaskStage[]> = {
  planning: ["execution"],
  execution: ["validation", "planning"],
  validation: ["done", "execution", "planning"],
  done: [],
};

/** Day14 hook: инварианты-фильтры встраиваются сюда, вызовы не меняются. */
export function canTransition(from: TaskStage, to: TaskStage): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function keyOf(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export type TaskTransitionResult =
  | { kind: "ok"; state: TaskState }
  | { kind: "not_found" }
  | {
      kind: "invalid";
      from: TaskStage;
      to?: TaskStage;
      allowed?: TaskStage[];
      message: string;
    };

/**
 * Day13: per-agent task FSM — key `${instanceId}|${agentId}`, одна активная
 * задача на агента (ветки #a/#b не дублируют задачу). get() чистый;
 * onChange — только при успешной мутации (409-спам не пишет на диск).
 */
export class TaskStateStore {
  private readonly byKey = new Map<string, TaskState>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: TaskStateOptions = {}) {
    this.onChange = opts.onChange;
  }

  get(instanceId: string, agentId: string): TaskState | null {
    const found = this.byKey.get(keyOf(instanceId, agentId));
    return found ? this.copy(found) : null;
  }

  create(instanceId: string, agentId: string, data: TaskCreate): TaskState | "exists" {
    const key = keyOf(instanceId, agentId);
    if (this.byKey.has(key)) return "exists";
    const task: TaskState = {
      id: crypto.randomUUID(),
      title: data.title,
      stage: "planning",
      step: 1,
      plan: [...data.plan],
      expectedAction: data.expectedAction?.trim() || data.plan[0]!,
      paused: false,
      pausedFrom: null,
      lastStageNote: "",
      updatedAt: nowIso(),
    };
    this.byKey.set(key, task);
    this.onChange?.();
    return this.copy(task);
  }

  transition(
    instanceId: string,
    agentId: string,
    command: TaskTransition,
  ): TaskTransitionResult {
    const key = keyOf(instanceId, agentId);
    const task = this.byKey.get(key);
    if (!task) return { kind: "not_found" };
    const from = task.stage;
    const fail = (
      message: string,
      extra?: { to?: TaskStage; allowed?: TaskStage[] },
    ) => ({
      kind: "invalid" as const,
      from,
      to: extra?.to,
      allowed: extra?.allowed,
      message,
    });

    if (command.action === "goto") {
      const to = command.to;
      if (!to) return fail("Для goto обязателен to");
      if (from === "done") return fail("Задача завершена — начните новую", { to });
      if (task.paused) return fail("Пауза замораживает машину — сначала resume", { to });
      if (!canTransition(from, to)) {
        return fail(`Переход ${from} → ${to} запрещён`, {
          to,
          allowed: [...ALLOWED_TRANSITIONS[from]],
        });
      }
      task.stage = to;
      task.updatedAt = nowIso();
      this.byKey.set(key, task);
      this.onChange?.();
      return { kind: "ok", state: this.copy(task) };
    }

    if (command.action === "pause") {
      if (from === "done") return fail("Завершённую задачу нельзя поставить на паузу");
      if (task.paused) return fail("Задача уже на паузе");
      task.paused = true;
      task.pausedFrom = from;
      task.updatedAt = nowIso();
      this.byKey.set(key, task);
      this.onChange?.();
      return { kind: "ok", state: this.copy(task) };
    }

    if (command.action === "resume") {
      if (!task.paused) return fail("Задача не на паузе");
      task.paused = false;
      task.pausedFrom = null;
      task.updatedAt = nowIso();
      this.byKey.set(key, task);
      this.onChange?.();
      return { kind: "ok", state: this.copy(task) };
    }

    // next_step: только в execution (шаг — execution-термин), не на последнем шаге.
    if (from !== "execution") return fail("Шаг меняется только в execution");
    if (task.step >= task.plan.length) return fail("Это последний шаг плана");
    task.step += 1;
    task.expectedAction = task.plan[task.step - 1]!;
    task.updatedAt = nowIso();
    this.byKey.set(key, task);
    this.onChange?.();
    return { kind: "ok", state: this.copy(task) };
  }

  /** PATCH при paused разрешён (заморожены только stage/step/переходы). */
  patch(instanceId: string, agentId: string, patch: TaskPatch): TaskState | null {
    const key = keyOf(instanceId, agentId);
    const task = this.byKey.get(key);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.expectedAction !== undefined) task.expectedAction = patch.expectedAction;
    if (patch.lastStageNote !== undefined) task.lastStageNote = patch.lastStageNote;
    if (patch.plan !== undefined) {
      task.plan = [...patch.plan];
      // Clamp: после укорачивания плана шаг не может указывать за пределы.
      task.step = Math.min(task.step, task.plan.length);
    }
    task.updatedAt = nowIso();
    this.byKey.set(key, task);
    this.onChange?.();
    return this.copy(task);
  }

  remove(instanceId: string, agentId: string): boolean {
    const removed = this.byKey.delete(keyOf(instanceId, agentId));
    if (removed) this.onChange?.();
    return removed;
  }

  clearAgent(instanceId: string, agentId: string): void {
    this.byKey.delete(keyOf(instanceId, agentId));
    this.onChange?.();
  }

  snapshot(): Record<string, TaskState> {
    return Object.fromEntries([...this.byKey.entries()].map(([k, v]) => [k, this.copy(v)]));
  }

  load(map: Record<string, TaskState> | undefined): void {
    this.byKey.clear();
    for (const [k, v] of Object.entries(map ?? {})) {
      this.byKey.set(k, this.copy(v));
    }
  }

  private copy(task: TaskState): TaskState {
    return { ...task, plan: [...task.plan] };
  }
}

const PLANNING_HINTS = ["план", "предлагаю", "уточн", "давайте определим"];
const VALIDATION_HINTS = ["оцен", "эффект", "провер", "стало", "почувств", "результат"];

const STOP_WORDS = new Set([
  "техника",
  "упражнение",
  "шаг",
  "этап",
  "текущий",
  "сейчас",
  "делать",
]);

function meaningfulWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[«»":;,.!?—\-()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/**
 * Day13 D-7: детерминированный скелет проверки стадии — fail-open (ответ не
 * режется, только evidence). level: "ok" | "warn" (critical — день 14,
 * инварианты-нарушения). Эвристика execution — пересечение значимых слов
 * expectedAction с ответом (лейбл категории до «:» и стоп-слова не считаются):
 * модель не обязана дословно цитировать название шага.
 */
export function validateTaskReply(
  task: TaskState,
  reply: string,
): { ok: boolean; level: "ok" | "warn"; note: string } {
  const text = reply.toLowerCase();
  if (!reply.trim()) {
    return { ok: false, level: "warn", note: "Пустой ответ" };
  }
  if (task.stage === "planning") {
    const hasPlanShape = /\?\s*$|\d[.)]\s|•|^\s*-\s|—\s|«/m.test(reply) ||
      PLANNING_HINTS.some((h) => text.includes(h));
    return hasPlanShape
      ? { ok: true, level: "ok", note: "Planning: уточнение/план" }
      : { ok: false, level: "warn", note: "Похоже на реализацию — стадия planning" };
  }
  if (task.stage === "execution") {
    const current = task.plan[task.step - 1] ?? "";
    const probe = new Set([
      ...meaningfulWords(task.expectedAction),
      ...meaningfulWords(current),
    ]);
    const hit = [...probe].some((w) => text.includes(w));
    return hit
      ? { ok: true, level: "ok", note: `Выполняется шаг ${task.step}/${task.plan.length}` }
      : {
          ok: false,
          level: "warn",
          note: `Шаг ${task.step}/${task.plan.length} не подтверждён в ответе`,
        };
  }
  if (task.stage === "validation") {
    const hinted = VALIDATION_HINTS.some((h) => text.includes(h));
    return hinted
      ? { ok: true, level: "ok", note: "Validation: приглашение к оценке эффекта" }
      : {
          ok: false,
          level: "warn",
          note: "Нет приглашения оценить эффект — стадия validation",
        };
  }
  return { ok: true, level: "ok", note: "Задача завершена" };
}

export function createTaskStateStore(opts?: TaskStateOptions): TaskStateStore {
  return new TaskStateStore(opts);
}
