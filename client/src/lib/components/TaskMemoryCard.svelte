<script lang="ts">
  // «Память задачи» (D-3, Day25): цель/уточнено/ограничения — компактная
  // редактируемая карточка над композером. GET on load, PATCH on blur.
  import { dialog } from "../stores/dialog.svelte";

  let editing = $state(false);
  /** Сворачивание панели (Костя 04.10: «уметь прятать»): шапка остаётся. */
  let collapsed = $state(false);
  let goal = $state("");
  let clarified = $state("");
  let constraints = $state("");

  function startEdit(): void {
    goal = dialog.chatTask?.goal ?? "";
    clarified = (dialog.chatTask?.clarified ?? []).join("\n");
    constraints = (dialog.chatTask?.constraints_terms ?? []).join("\n");
    editing = true;
  }

  /** Строки черновика → валидный список (кап 8 — как в схеме). */
  function lines(s: string): string[] {
    return s
      .split(/\n+/)
      .map((x) => x.trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 8);
  }

  /** PATCH on blur: absent = keep (02b-F-1) — шлём всё поле целиком. */
  async function save(): Promise<void> {
    if (!editing) return;
    try {
      await dialog.patchChatTask({
        goal: goal.slice(0, 300),
        clarified: lines(clarified),
        constraints_terms: lines(constraints),
      });
    } catch (e) {
      dialog.error = e instanceof Error ? e.message : String(e);
    }
  }

  function finish(): void {
    editing = false;
  }

  let items = $derived({
    clarified: dialog.chatTask?.clarified ?? [],
    constraints: dialog.chatTask?.constraints_terms ?? [],
  });
</script>

<div class="task">
  <h4>
    <button type="button" class="tgl" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed} title={collapsed ? "Развернуть панель" : "Свернуть панель"}>
      <span class="chev" aria-hidden="true">{collapsed ? "▸" : "▾"}</span> Память задачи
    </button>
    {#if !collapsed}
      {#if editing}
        <button type="button" class="link" onclick={() => { void save(); finish(); }}>готово</button>
      {:else}
        <button type="button" class="link" onclick={startEdit}>изменить</button>
      {/if}
    {/if}
  </h4>
  {#if !collapsed}
    {#if editing}
    <label>
      Цель
      <input bind:value={goal} onblur={() => void save()} maxlength="300" placeholder="Например: техники самопомощи для шеи справа" />
    </label>
    <label>
      Уточнено (по строке)
      <textarea bind:value={clarified} onblur={() => void save()} rows="2" placeholder="боль отдаёт в голову к вечеру"></textarea>
    </label>
    <label>
      Ограничения (по строке)
      <textarea bind:value={constraints} onblur={() => void save()} rows="2" placeholder="нельзя задерживать дыхание"></textarea>
    </label>
  {:else}
    {#if dialog.chatTask && (dialog.chatTask.goal || items.clarified.length || items.constraints.length)}
      {#if dialog.chatTask.goal}<div class="g">Цель: {dialog.chatTask.goal}</div>{/if}
      {#if items.clarified.length}
        <div class="sec">Уточнено:</div>
        <ul>
          {#each items.clarified as it, i ("c" + i)}<li>{it}</li>{/each}
        </ul>
      {/if}
      {#if items.constraints.length}
        <div class="sec">Ограничения:</div>
        <ul>
          {#each items.constraints as it, i ("k" + i)}<li>{it}</li>{/each}
        </ul>
      {/if}
    {:else}
      <div class="hint">Пусто — заполнится из диалога или нажмите «изменить»</div>
    {/if}
    {/if}
  {/if}
</div>

<style>
  .task {
    margin: 4px 20px 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    padding: 10px 14px;
    box-shadow: var(--shadow-2);
    /* QA 041004 (S3-item5): на низких окнах карточка съедала ленту — кап + свой
       скролл; border-box: кап 168px — ВЕСЬ карточный бокс, не только контент
       (иначе padding раздувал её до 188px) */
    max-height: 168px;
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
  .tgl:hover {
    color: var(--ink);
  }
  .chev {
    font-size: 10px;
  }
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
  .g {
    font-weight: 600;
    font-size: 13px;
  }
  .sec {
    font: 600 11px/1 system-ui, sans-serif;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 6px 0 2px;
  }
  ul {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    color: var(--muted);
    font-size: 12.5px;
  }
  li {
    display: flex;
    gap: 6px;
  }
  li::before {
    content: "·";
    color: var(--accent);
    font-weight: 700;
  }
  .hint {
    color: var(--muted);
    font-size: 12.5px;
  }
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
  textarea:focus {
    outline: 1px solid var(--accent);
  }
</style>
