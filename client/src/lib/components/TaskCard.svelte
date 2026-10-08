<script lang="ts">
  // Задача-FSM (день 13, C+ хвосты): per-тред формальная машина — создать,
  // перейти по стадии (карта — shared ALLOWED_TRANSITIONS, кнопки —
  // STAGE_GOTO_LABELS), пауза/продолжить, следующий шаг, редактирование.
  // Хранение — локальное (chat-state.threadState.task); согласие на done —
  // инлайн-подтверждение (день 14 D-6: goto→done только с consent).
  import {
    ALLOWED_TRANSITIONS,
    STAGE_GOTO_LABELS,
    STAGE_LABELS,
    type TaskStage,
  } from "@trigger-helper/shared";
  import { dialog } from "../stores/dialog.svelte";
  import { uid } from "../uid";

  let collapsed = $state(false);
  let creating = $state(false);
  let editing = $state(false);
  let confirmingDone = $state(false);
  let title = $state("");
  let planText = $state("");
  let expectedAction = $state("");
  let stageNote = $state("");

  let task = $derived(dialog.task);

  function planLines(s: string): string[] {
    return s
      .split(/\n+/)
      .map((x) => x.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 5);
  }

  function startCreate(): void {
    title = "";
    planText = "";
    expectedAction = "";
    creating = true;
  }

  function submitCreate(): void {
    const plan = planLines(planText);
    if (!title.trim() || plan.length === 0) {
      dialog.error = "Задаче нужны название и хотя бы один шаг плана";
      return;
    }
    dialog.createTask({
      id: uid(),
      title: title.trim().slice(0, 120),
      plan,
      expectedAction: expectedAction.trim() || undefined,
    });
    creating = false;
    confirmingDone = false;
  }

  function startEdit(): void {
    if (!task) return;
    title = task.title;
    planText = task.plan.join("\n");
    expectedAction = task.expectedAction;
    stageNote = task.lastStageNote;
    editing = true;
  }

  function saveEdit(): void {
    const plan = planLines(planText);
    if (!task || !title.trim() || plan.length === 0) {
      dialog.error = "Задаче нужны название и хотя бы один шаг плана";
      return;
    }
    dialog.patchTask({
      title: title.trim().slice(0, 120),
      plan,
      expectedAction: expectedAction.trim().slice(0, 200),
      lastStageNote: stageNote.trim().slice(0, 200),
    });
    editing = false;
  }

  function goto(to: TaskStage): void {
    if (to === "done" && !confirmingDone) {
      confirmingDone = true; // consent-шаг (день 14 D-6)
      return;
    }
    confirmingDone = false;
    const result = dialog.taskCommand({ action: "goto", to, consent: to === "done" });
    if (result && result.kind === "invalid") dialog.error = result.message;
  }

  function run(command: Parameters<typeof dialog.taskCommand>[0]): void {
    confirmingDone = false;
    const result = dialog.taskCommand(command);
    if (result && result.kind === "invalid") dialog.error = result.message;
  }

  let targets = $derived(
    task && task.stage !== "done" && !task.paused
      ? ALLOWED_TRANSITIONS[task.stage]
      : [],
  );
</script>

<div class="task-card">
  <h4>
    <button type="button" class="tgl" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed} title={collapsed ? "Развернуть панель" : "Свернуть панель"}>
      <span class="chev" aria-hidden="true">{collapsed ? "▸" : "▾"}</span> Задача
    </button>
    {#if !collapsed}
      {#if task}
        {#if editing}
          <button type="button" class="link" onclick={saveEdit}>готово</button>
        {:else}
          <button type="button" class="link" onclick={startEdit}>изменить</button>
        {/if}
      {/if}
    {/if}
  </h4>
  {#if !collapsed}
    {#if !task}
      {#if creating}
        <label>
          Название
          <input bind:value={title} maxlength="120" placeholder="Например: убрать боль в шее справа" />
        </label>
        <label>
          План (по строке, 1–5 шагов)
          <textarea bind:value={planText} rows="3" placeholder="найти мышцу&#10;массаж 3 минуты&#10;проверить эффект"></textarea>
        </label>
        <label>
          Ожидаемое действие (необязательно — по умолчанию первый шаг)
          <input bind:value={expectedAction} maxlength="200" placeholder="найти мышцу пальцами" />
        </label>
        <div class="row">
          <button type="button" class="btn" onclick={submitCreate}>создать</button>
          <button type="button" class="link" onclick={() => (creating = false)}>отмена</button>
        </div>
      {:else}
        <div class="hint">Формальная задача со стадиями — создайте, чтобы вёл по шагам.
          <button type="button" class="link" onclick={startCreate}>+ создать задачу</button>
        </div>
      {/if}
    {:else if editing}
      <label>
        Название
        <input bind:value={title} maxlength="120" />
      </label>
      <label>
        План (по строке, 1–5 шагов)
        <textarea bind:value={planText} rows="3"></textarea>
      </label>
      <label>
        Ожидаемое действие
        <input bind:value={expectedAction} maxlength="200" />
      </label>
      <label>
        Заметка по стадии
        <input bind:value={stageNote} maxlength="200" />
      </label>
      <div class="row">
        <button type="button" class="btn" onclick={saveEdit}>готово</button>
        <button type="button" class="link" onclick={() => (editing = false)}>отмена</button>
      </div>
    {:else}
      <div class="g">{task.title}</div>
      <div class="stage">
        <span class="chip" data-stage={task.stage}>{STAGE_LABELS[task.stage]}</span>
        {#if task.stage === "execution"}<span class="muted">шаг {task.step}/{task.plan.length}</span>{/if}
        {#if task.paused}<span class="chip paused">пауза ({STAGE_LABELS[task.pausedFrom ?? task.stage]})</span>{/if}
      </div>
      {#if task.stage === "execution" && task.expectedAction}
        <div class="muted">Сейчас: {task.expectedAction}</div>
      {/if}
      {#if task.lastStageNote}<div class="muted note">{task.lastStageNote}</div>{/if}
      <ol class="plan">
        {#each task.plan as stepLine, i (i)}
          <li class:current={task.stage === "execution" && i === task.step - 1}>{stepLine}</li>
        {/each}
      </ol>
      {#if task.stage !== "done"}
        <div class="row">
          {#each targets as to (to)}
            <button type="button" class="btn" onclick={() => goto(to)}>{STAGE_GOTO_LABELS[to]}</button>
          {/each}
        </div>
        {#if confirmingDone}
          <div class="row confirm">
            Завершить проработку?
            <button type="button" class="btn" onclick={() => goto("done")}>да</button>
            <button type="button" class="link" onclick={() => (confirmingDone = false)}>нет</button>
          </div>
        {/if}
        <div class="row">
          {#if task.paused}
            <button type="button" class="btn" onclick={() => run({ action: "resume" })}>продолжить</button>
          {:else}
            <button type="button" class="btn" onclick={() => run({ action: "pause" })}>пауза</button>
          {/if}
          {#if task.stage === "execution" && task.step < task.plan.length}
            <button type="button" class="btn" onclick={() => run({ action: "next_step" })}>шаг выполнен → далее</button>
          {/if}
          <button type="button" class="link danger" onclick={() => { dialog.removeTask(); confirmingDone = false; }}>снять задачу</button>
        </div>
      {:else}
        <div class="hint">Задача завершена — «снять» или создайте новую.</div>
        <div class="row"><button type="button" class="link danger" onclick={() => dialog.removeTask()}>снять задачу</button></div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .task-card {
    margin: 4px 20px 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    padding: 10px 14px;
    box-shadow: var(--shadow-2);
    max-height: 220px;
    overflow-y: auto;
    box-sizing: border-box;
    flex: none;
  }
  h4 {
    font: 600 12px/1 system-ui, sans-serif;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 6px;
    display: flex;
    justify-content: space-between;
  }
  .tgl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: none;
    padding: 0;
    color: var(--muted);
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .tgl:hover { color: var(--ink); }
  .chev { font-size: 10px; }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
    font: 600 12px/1 system-ui, sans-serif;
  }
  .link.danger { color: var(--muted); }
  .link.danger:hover { color: #c0392b; }
  .btn {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--ink);
    padding: 5px 10px;
    font: 600 12px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .btn:hover { border-color: var(--accent); }
  .g { font-weight: 600; font-size: 13px; }
  .stage { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .chip {
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 999px;
    padding: 2px 8px;
    font: 600 11px/1.4 system-ui, sans-serif;
  }
  .chip.paused { border-color: var(--muted); color: var(--muted); }
  .muted { color: var(--muted); font-size: 12.5px; }
  .note { font-style: italic; }
  .plan {
    margin: 4px 0 6px;
    padding-left: 18px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .plan li.current { color: var(--ink); font-weight: 600; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .confirm { font-size: 12.5px; color: var(--ink); }
  .hint { color: var(--muted); font-size: 12.5px; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  input,
  textarea {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 8px;
    font: 13px/1.5 system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg);
    resize: vertical;
  }
  input:focus,
  textarea:focus { outline: 1px solid var(--accent); }
</style>
