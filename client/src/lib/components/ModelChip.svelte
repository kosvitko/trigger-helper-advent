<script lang="ts">
  // Model-chip (D-3): модель хода; P0-настройка — единственная (run-override).
  // QA 041003 (F3): у пресетов нет defaultModel — захардкоженный «deepseek-chat»
  // расходился с фактом (env-дефолт сервера). Правду знаем после живого хода.
  import { settings } from "../stores/settings.svelte";
  import { session } from "../stores/session.svelte";
  import { trace } from "../stores/trace.svelte";

  let agentDefault = $derived(session.activeAgent?.defaultModel ?? null);
  let lastActual = $derived(trace.lastLiveModel());
  let current = $derived(
    settings.overrides.model ?? agentDefault ?? lastActual ?? "по умолчанию агента",
  );
</script>

<label class="model-chip" title="Модель хода (run-override, настройка P0)">
  Модель: <b>{current}</b>
  <select
    value={settings.overrides.model ?? ""}
    onchange={(e) => settings.setModel((e.currentTarget as HTMLSelectElement).value || undefined)}
    aria-label="Модель хода"
  >
    <option value="">по умолчанию агента{agentDefault ? ` (${agentDefault})` : ""}</option>
    {#each settings.models as m (m.model)}
      <option value={m.model}>{m.model} · {m.label}</option>
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
