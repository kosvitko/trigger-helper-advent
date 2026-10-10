<script lang="ts">
  // Model-chip (D-3): модель хода; P0-настройка — единственная (override).
  // QA 041003 (F3): дефолт-модели агента больше нет (STATEFUL умер, CH-5b) —
  // правду знаем после живого хода, до него — серверный дефолт.
  // День 26 (D-26-2/D-26-4): в дропдаун добавляются ДОСТУПНЫЕ локальные
  // записи («локальная · »). День 28: в rag_chat локальная ветка ДЕЛАЕТ
  // retrieval по базе (proposals 261009 §3.1-1) — суффикс « · RAG» (факт
  // поиска); прочие пресеты — без суффикса (как до дня 28).
  import { settings } from "../stores/settings.svelte";
  import { session } from "../stores/session.svelte";
  import { trace } from "../stores/trace.svelte";

  let lastActual = $derived(trace.lastLiveModel());
  let current = $derived(
    settings.overrides.model ?? lastActual ?? "по умолчанию сервера",
  );
  let localSuffix = $derived(
    session.activeThread?.preset === "rag_chat" ? " · RAG" : "",
  );
</script>

<label class="model-chip" title="Модель хода (override, настройка P0)">
  Модель: <b>{current}</b>
  <select
    value={settings.overrides.model ?? ""}
    onchange={(e) => settings.setModel((e.currentTarget as HTMLSelectElement).value || undefined)}
    aria-label="Модель хода"
  >
    <option value="">по умолчанию сервера</option>
    {#each settings.models as m (m.model)}
      <option value={m.model}>{m.model} · {m.label}</option>
    {/each}
    {#each settings.availableLocalModels as e (e.id)}
      <option value={e.id}>локальная · {e.label}{localSuffix}</option>
    {/each}
  </select>
</label>

<style>
  .model-chip {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    background: var(--chip);
    border-radius: 999px;
    padding: 4px 10px;
    font: 600 12px/1 system-ui, sans-serif;
    color: var(--muted);
    cursor: pointer;
  }
  .model-chip b {
    color: var(--accent);
  }
  select {
    border: 0;
    background: transparent;
    font: 600 12px/1 system-ui, sans-serif;
    color: var(--muted);
    cursor: pointer;
    outline: 0;
  }
</style>
