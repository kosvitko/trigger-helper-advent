<script lang="ts">
  // Трейс-колонка (D-4): пост-хок таймлайн ходов + сводка сессии в подвале.
  // Сворачивание ходов — эфемерный UI-стейт (F-2), живёт в колонке.
  import TurnBlock from "./TurnBlock.svelte";
  import TaskMemoryCard from "./TaskMemoryCard.svelte";
  import { trace } from "../stores/trace.svelte";
  import { fmtRub, fmtTok, plural } from "../format";

  /** Ход на линии фокуса связного скролла (P2, D-2) — подсветка блока. */
  let { focusedTurnId = null, onalign }: { focusedTurnId?: string | null; onalign?: (turnId: string) => void } = $props();

  let openTurns = $state<Set<string>>(new Set());
  let prevLatest: string | null = null; // предыдущий последний ход

  let turns = $derived(trace.ordered);
  let totals = $derived(trace.totals());

  // Когда последний ход меняется (новый ход или бут) — открываем ТОЛЬКО его,
  // остальные закрываем (слова Кости: «автораскрывать только последний ход,
  // а остальные автозакрывать»). Ручные клики по старым ходам живут до
  // следующего нового хода.
  $effect(() => {
    const ids = turns.map((t) => t.turnId);
    if (ids.length > 0) {
      const latest = ids[ids.length - 1];
      if (latest !== prevLatest) {
        openTurns = new Set([latest]);
        prevLatest = latest;
      }
    }
  });

  function toggle(id: string): void {
    const next = new Set(openTurns);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openTurns = next;
  }
</script>

<div class="col-h">Трейс · все шаги модели</div>

<div class="trace" data-trace>
  {#if turns.length === 0}
    <div class="empty">Ходов пока нет — задайте вопрос в диалоге</div>
  {/if}
  {#each turns as t, i (t.turnId)}
    <TurnBlock turn={t} index={i + 1} open={openTurns.has(t.turnId)} ontoggle={() => { toggle(t.turnId); onalign?.(t.turnId); }} focused={t.turnId === focusedTurnId} />
  {/each}
</div>

<!-- Память задачи — внизу ТРЕЙСА (решение Кости 04.10): в «Диалоге» колонка
     погашена — карточка исчезает вместе с трейсом. -->
<TaskMemoryCard />

<div class="foot">
  Сессия: {totals.turns} {plural(totals.turns, "ход", "хода", "ходов")} · {fmtTok(totals.tokens)} ток ·
      {fmtRub(totals.rub)}
  {#if totals.railTotal > 0}
      · рельса источников {totals.railOk}/{totals.railTotal}
      {totals.railTotal - totals.railOk > 0 ? ` · нарушений: ${totals.railTotal - totals.railOk}` : " · нарушений 0"}
      {totals.railOk === totals.railTotal ? "✓" : "✕"}
  {:else}
      · рельса — (нет живых ходов в этой вкладке)
  {/if}
</div>

<style>
  .col-h {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px 8px;
    font: 600 13px/1 system-ui, sans-serif;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .trace {
    flex: 1;
    overflow: auto;
    padding: 4px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    margin: auto;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
    max-width: 34ch;
  }
  .foot {
    padding: 8px 20px;
    color: var(--muted);
    font-size: 11.5px;
    border-top: 1px solid var(--line);
    background: var(--surface);
    font-variant-numeric: tabular-nums;
  }
</style>
