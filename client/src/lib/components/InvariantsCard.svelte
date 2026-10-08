<script lang="ts">
  // Инварианты (день 14, C+ хвосты): правила владельца per-тред — строки
  // живут на клиенте (contextTail.invariants), проверки — сервер per-request
  // (CH-5a). Редактор рядов: текст + охват + жёсткость (+ pattern для hard),
  // активность, удаление; кап 8 (как в схеме хранения).
  import type { InvariantRow } from "@trigger-helper/shared";
  import { dialog } from "../stores/dialog.svelte";
  import { INVARIANTS_MAX } from "../chat-state";
  import { uid } from "../uid";

  let collapsed = $state(false);
  let adding = $state(false);
  let text = $state("");
  let scope = $state<"agent" | "task">("agent");
  let enforcement = $state<"hard" | "soft">("hard");
  let pattern = $state("");

  let rows = $derived(dialog.invariants);
  let activeCount = $derived(rows.filter((r) => r.active).length);

  function addRow(): void {
    const t = text.trim().slice(0, 200);
    if (!t || rows.length >= INVARIANTS_MAX) {
      dialog.error = rows.length >= INVARIANTS_MAX ? `Максимум ${INVARIANTS_MAX} инвариантов` : "Текст правила пуст";
      return;
    }
    const now = new Date().toISOString();
    const row: InvariantRow = {
      id: uid(),
      text: t,
      scope,
      enforcement,
      ...(enforcement === "hard" && pattern.trim() ? { pattern: pattern.trim().slice(0, 120) } : {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    dialog.setInvariants([...rows, row]);
    text = "";
    pattern = "";
    adding = false;
  }

  function toggle(row: InvariantRow): void {
    dialog.setInvariants(
      rows.map((r) => (r.id === row.id ? { ...r, active: !r.active, updatedAt: new Date().toISOString() } : r)),
    );
  }

  function remove(row: InvariantRow): void {
    dialog.setInvariants(rows.filter((r) => r.id !== row.id));
  }
</script>

<div class="inv-card">
  <h4>
    <button type="button" class="tgl" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed} title={collapsed ? "Развернуть панель" : "Свернуть панель"}>
      <span class="chev" aria-hidden="true">{collapsed ? "▸" : "▾"}</span> Инварианты
    </button>
    {#if !collapsed && rows.length < INVARIANTS_MAX}
      <button type="button" class="link" onclick={() => (adding = !adding)}>{adding ? "отмена" : "+ правило"}</button>
    {/if}
  </h4>
  {#if !collapsed}
    {#if adding}
      <label>
        Правило (что агенту нельзя/обязательно)
        <input bind:value={text} maxlength="200" placeholder="не рекомендуй задержку дыхания" />
      </label>
      <div class="opts">
        <label>
          Охват
          <select bind:value={scope}>
            <option value="agent">агент</option>
            <option value="task">задача</option>
          </select>
        </label>
        <label>
          Жёсткость
          <select bind:value={enforcement}>
            <option value="hard">жёсткое</option>
            <option value="soft">мягкое</option>
          </select>
        </label>
      </div>
      {#if enforcement === "hard"}
        <label>
          RegExp-паттерн конфликта (необязательно; только для жёстких)
          <input bind:value={pattern} maxlength="120" placeholder="задерж\w* дыхан" />
        </label>
      {/if}
      <div class="row">
        <button type="button" class="btn" onclick={addRow}>добавить</button>
      </div>
    {/if}
    {#if rows.length === 0 && !adding}
      <div class="hint">Правила владельца: проверяются сервером на каждом ходу (день 14).</div>
    {:else}
      <ul>
        {#each rows as row (row.id)}
          <li>
            <input
              type="checkbox"
              checked={row.active}
              onchange={() => toggle(row)}
              title={row.active ? "Исключить из проверок" : "Вернуть в проверки"}
            />
            <span class="txt" class:off={!row.active}>{row.text}</span>
            <span class="tags">
              <span class="tag">{row.scope === "agent" ? "агент" : "задача"}</span>
              <span class="tag" class:hard={row.enforcement === "hard"}>{row.enforcement === "hard" ? "жёсткое" : "мягкое"}</span>
              {#if row.pattern}<span class="tag mono">/{row.pattern}/</span>{/if}
            </span>
            <button type="button" class="link danger" onclick={() => remove(row)} title="Удалить правило">×</button>
          </li>
        {/each}
      </ul>
      {#if rows.length > 0}
        <div class="muted">активных: {activeCount} из {rows.length} · в ход уходят только активные</div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .inv-card {
    margin: 4px 20px 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    padding: 10px 14px;
    box-shadow: var(--shadow-2);
    max-height: 200px;
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
  ul {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12.5px;
  }
  li input[type="checkbox"] { align-self: center; }
  .txt { color: var(--ink); }
  .txt.off { color: var(--muted); text-decoration: line-through; }
  .tags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .tag {
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    padding: 1px 6px;
    font-size: 10.5px;
    white-space: nowrap;
  }
  .tag.hard { border-color: var(--accent); color: var(--accent); }
  .tag.mono { font-family: ui-monospace, monospace; }
  .muted { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
  .hint { color: var(--muted); font-size: 12.5px; }
  .row { display: flex; gap: 8px; margin-top: 6px; }
  .opts { display: flex; gap: 10px; }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  input:not([type]),
  select {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 8px;
    font: 13px/1.5 system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg);
  }
  input:focus,
  select:focus { outline: 1px solid var(--accent); }
</style>
