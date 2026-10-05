<script lang="ts">
  // Сегмент «Диалог | Оба | Трейс» (D-2) — переключение раскладки A1.
  import type { ViewMode } from "../types";

  let { value = $bindable("both") }: { value?: ViewMode } = $props();

  const items: { id: ViewMode; label: string }[] = [
    { id: "dialog", label: "Диалог" },
    { id: "both", label: "Оба" },
    { id: "trace", label: "Трейс" },
  ];
</script>

<div class="seg" role="group" aria-label="Раскладка колонок">
  {#each items as it (it.id)}
    <button type="button" class:on={value === it.id} onclick={() => (value = it.id)}>{it.label}</button>
  {/each}
</div>

<style>
  .seg {
    display: flex;
    background: var(--chip);
    border-radius: 999px;
    padding: 3px;
  }
  .seg button {
    border: 0;
    background: transparent;
    padding: 6px 16px;
    border-radius: 999px;
    font: 600 13px/1 system-ui, sans-serif;
    color: var(--muted);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow-2);
  }
</style>
