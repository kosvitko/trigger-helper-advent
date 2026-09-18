import type {
  InvariantRow,
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

/**
 * Day15′ (260919, Pick B): русские имена этапов для UI-кнопок и LLM-инжекта —
 * один источник (не дублировать в JS-фронтенде: UI берёт из meta.stageLabels).
 * API-контракт (stage id) не меняется — это только слой отображения.
 */
export const STAGE_LABELS: Record<TaskStage, string> = {
  planning: "Разбор",
  execution: "Практика",
  validation: "Проверка эффекта",
  done: "Готово",
};

/** Русские подписи переходов для кнопок: куда пользователь может нажать. */
export const STAGE_GOTO_LABELS: Record<TaskStage, string> = {
  planning: "Вернуться к разбору",
  execution: "К практике",
  validation: "Проверить эффект",
  done: "Завершить проработку",
};

/**
 * Day15 D-2: детерминированный признак skip-запроса — «игнорируй все стадии»,
 * «перепрыгни этап», «выдай сразу результат без плана» (красный путь, чат
 * Гладкова 18.09). Консервативный: только игнор-глагол/перескок рядом со
 * «стадия/этап» или императив с «сразу»; общие «стадия/этап» без игнор-глагола
 * не матчатся (медицинское «какая стадия остеохондроза?» — не красный путь).
 * Для кириллицы \b не работает (\w = латиница) — границы опускаем.
 */
const SKIP_DEMAND_RE =
  /игнорир[а-яё]*\s+(все\s+)?(стади|этап)|пропусти[а-яё]*\s+(все\s+)?(стади|этап)|перепрыгн[а-яё]*|перескоч[а-яё]*\s+(этап|стади)|наруш[а-яё]*\s+(все\s+)?(стади|этап)|(выдай|дай|напиши|сделай|покажи)[а-яё]*\s+(сразу|немедленно)|(сразу|немедленно)\s+(выдай|дай|напиши|сделай|покажи)[а-яё]*|без\s+(плана|стадий|этапов)|\bskip\s+(the\s+)?stages?\b|\bignore\s+(the\s+)?(stages?|steps?)\b|\bjump\s+(straight\s+)?to\s+(the\s+)?(end|final|done)\b/i;

export function isStageSkipDemand(input: string): boolean {
  return SKIP_DEMAND_RE.test(input);
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
      /** Day14 D-6: goto→done без подтверждения пользователя. */
      consentRequired?: boolean;
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
      // Day14 D-6: инвариант согласия — последний гвард goto-ветки (после
      // карты): без consent на запрещённом переходе клиент получает
      // каноничный 409 с allowed[], а не consentRequired.
      if (to === "done" && command.consent !== true) {
        return {
          kind: "invalid",
          from,
          to,
          message: "Переход в done требует подтверждения пользователя",
          consentRequired: true,
        };
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

/** Day14 D-7(a): маркеры отказа — цитата [INV-n] сильнее (см. checkInvariants). */
const REFUSAL_MARKERS = [
  "не могу",
  "не буду",
  "не стану",
  "не помогу",
  "не рекомендую",
  "не стоит",
  "отказываюсь",
  "отказ",
];

/**
 * Day14 D-7(a): детерминированный инвариант-чек, независим от задачи.
 * Конфликтный ряд = первый hard+pattern в merge-порядке (agent→task), чей
 * RegExp("i") матчит input; цитата [INV-n] засчитывается только при n = номеру
 * этого ряда, неверный n — спасает только лексикон отказа. Fail-open.
 */
function checkInvariants(
  invariants: InvariantRow[],
  input: string,
  reply: string,
): { ok: boolean; level: "ok" | "warn" | "critical"; note: string } {
  for (let i = 0; i < invariants.length; i += 1) {
    const row = invariants[i]!;
    if (row.enforcement !== "hard" || !row.pattern) continue;
    let re: RegExp;
    try {
      re = new RegExp(row.pattern, "i");
    } catch {
      continue;
    }
    if (!re.test(input)) continue;
    const n = i + 1;
    // Модель может цитировать с аннотацией «[INV-1: текст]» — засчитываем
    // префикс метки (граница после номера), не только точную «[INV-n]».
    const citation = new RegExp(`\\[INV-${n}\\b`, "i").test(reply);
    if (
      citation ||
      REFUSAL_MARKERS.some((m) => reply.toLowerCase().includes(m))
    ) {
      return { ok: true, level: "ok", note: `Конфликт распознан — отказ [INV-${n}]` };
    }
    return {
      ok: false,
      level: "critical",
      note: `Запрос конфликтует с [INV-${n}] — отказа нет`,
    };
  }
  return { ok: true, level: "ok", note: "Инварианты учтены" };
}

/**
 * Day13 D-7 (+ Day14 D-7, + Day15 D-2): детерминированный скелет проверки —
 * fail-open (ответ не режется, только evidence). С invariants+input —
 * инвариант-чек (независим от задачи, D-7a); с task — стадийные эвристики,
 * task допускает null (нейтральный дефолт). level: "ok" | "warn" | "critical"
 * (critical — красное нарушение: инвариант-нарушение, день 14, или стадия
 * при skip-запросе, день 15; см. isStageSkipDemand). Эвристика execution —
 * пересечение значимых слов expectedAction с ответом (лейбл категории до «:»
 * и стоп-слова не считаются): модель не обязана дословно цитировать шаг.
 */
export function validateTaskReply(
  task: TaskState | null,
  reply: string,
  opts?: { invariants?: InvariantRow[]; input?: string },
): { ok: boolean; level: "ok" | "warn" | "critical"; note: string } {
  if (opts?.invariants?.length && typeof opts.input === "string") {
    return checkInvariants(opts.invariants, opts.input, reply);
  }
  if (!task) {
    return { ok: true, level: "ok", note: "—" };
  }
  // Day15 D-2: skip-запрос превращает провал стадии в critical (красный путь);
  // без него — warn как day13. Инвариант-ветка выше вернулась раньше, поэтому
  // opts.input здесь с day14-семантикой не конфликтует.
  const skip = opts?.input ? isStageSkipDemand(opts.input) : false;
  const text = reply.toLowerCase();
  if (!reply.trim()) {
    return { ok: false, level: "warn", note: "Пустой ответ" };
  }
  if (task.stage === "planning") {
    const hasPlanShape = /\?\s*$|\d[.)]\s|•|^\s*-\s|—\s|«/m.test(reply) ||
      PLANNING_HINTS.some((h) => text.includes(h));
    return hasPlanShape
      ? { ok: true, level: "ok", note: "Planning: уточнение/план" }
      : {
          ok: false,
          level: skip ? "critical" : "warn",
          note: skip
            ? "Стадия planning проигнорирована — запрос требует перескока"
            : "Похоже на реализацию — стадия planning",
        };
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
          level: skip ? "critical" : "warn",
          note: skip
            ? "Стадия execution проигнорирована — запрос требует перескока"
            : `Шаг ${task.step}/${task.plan.length} не подтверждён в ответе`,
        };
  }
  if (task.stage === "validation") {
    const hinted = VALIDATION_HINTS.some((h) => text.includes(h));
    return hinted
      ? { ok: true, level: "ok", note: "Validation: приглашение к оценке эффекта" }
      : {
          ok: false,
          level: skip ? "critical" : "warn",
          note: skip
            ? "Стадия validation проигнорирована — запрос требует перескока"
            : "Нет приглашения оценить эффект — стадия validation",
        };
  }
  return { ok: true, level: "ok", note: "Задача завершена" };
}

export function createTaskStateStore(opts?: TaskStateOptions): TaskStateStore {
  return new TaskStateStore(opts);
}
