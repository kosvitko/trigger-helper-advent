import type { InvariantRow, TaskStage, TaskState } from "./agent.js";
/**
 * C+ (CH-5a, D-4): чистая логика FSM задачи и проверок — в shared.
 * День13: хранение состояния — клиент (contextTail.task), гварды
 * переходов — один источник здесь (переходы задаёт код, не промпт).
 * День14: инварианты — строки-клиент, но проверки-сервер per-request
 * (защита владельца + гейт платного ретрая не могут жить на клиенте) —
 * чистые функции здесь, сервер зовёт их в /api/chat.
 * Перенесено дословно из server/services/agent/task-state.ts (05.10);
 * с cutover CH-6 серверного хранилища нет — операции FSM (ниже) тоже
 * живут здесь, клиент применяет их к локальной задаче.
 */

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

// --- C+ хвосты (UI-долг волны): операции FSM — на клиенте -------------------
// День 13/14/15: мутации задачи жили в серверном TaskStateStore (снят CH-6,
// D-10); хранение — клиент (contextTail.task). Правила перенесены дословно
// из снятого стора: карта переходов + согласие на done, пауза морозит FSM,
// next_step — только execution и не последний шаг, PATCH клампит шаг.

export type TaskCommand =
  | { action: "goto"; to: TaskStage; consent?: boolean }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "next_step" };

export type TaskCommandResult =
  | { kind: "ok"; task: TaskState }
  | {
      kind: "invalid";
      message: string;
      allowed?: TaskStage[];
      /** goto→done без согласия — UI показывает подтверждение и повторяет. */
      consentRequired?: boolean;
    };

/** Создание задачи (id — за вызывающим: клиент генерит uid). */
export function createTaskState(
  input: { id: string; title: string; plan: string[]; expectedAction?: string },
  now: () => string = () => new Date().toISOString(),
): TaskState {
  const plan = [...input.plan];
  return {
    id: input.id,
    title: input.title,
    stage: "planning",
    step: 1,
    plan,
    expectedAction: input.expectedAction?.trim() || plan[0] || "",
    paused: false,
    pausedFrom: null,
    lastStageNote: "",
    updatedAt: now(),
  };
}

/** Команда FSM → новое состояние (иммутабельно) или каноничная ошибка. */
export function applyTaskCommand(
  task: TaskState,
  command: TaskCommand,
  now: () => string = () => new Date().toISOString(),
): TaskCommandResult {
  const updated = (patch: Partial<TaskState>): TaskCommandResult => ({
    kind: "ok",
    task: { ...task, ...patch, updatedAt: now() },
  });

  if (command.action === "goto") {
    const to = command.to;
    if (task.stage === "done") {
      return { kind: "invalid", message: "Задача завершена — начните новую" };
    }
    if (task.paused) {
      return { kind: "invalid", message: "Пауза замораживает машину — сначала resume" };
    }
    if (!canTransition(task.stage, to)) {
      return {
        kind: "invalid",
        message: `Переход ${task.stage} → ${to} запрещён`,
        allowed: [...ALLOWED_TRANSITIONS[task.stage]],
      };
    }
    // День 14 D-6: goto→done без согласия — каноничный consentRequired,
    // а не «запрещено» (после карты переходов).
    if (to === "done" && command.consent !== true) {
      return {
        kind: "invalid",
        message: "Переход в done требует подтверждения пользователя",
        consentRequired: true,
      };
    }
    return updated({ stage: to });
  }

  if (command.action === "pause") {
    if (task.stage === "done") {
      return { kind: "invalid", message: "Завершённую задачу нельзя поставить на паузу" };
    }
    if (task.paused) {
      return { kind: "invalid", message: "Задача уже на паузе" };
    }
    return updated({ paused: true, pausedFrom: task.stage });
  }

  if (command.action === "resume") {
    if (!task.paused) {
      return { kind: "invalid", message: "Задача не на паузе" };
    }
    return updated({ paused: false, pausedFrom: null });
  }

  // next_step: только в execution (шаг — execution-термин), не последний.
  if (task.stage !== "execution") {
    return { kind: "invalid", message: "Шаг меняется только в execution" };
  }
  if (task.step >= task.plan.length) {
    return { kind: "invalid", message: "Это последний шаг плана" };
  }
  const step = task.step + 1;
  return updated({ step, expectedAction: task.plan[step - 1] ?? task.expectedAction });
}
