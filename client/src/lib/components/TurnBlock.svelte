<script lang="ts">
  // Блок хода трейса (D-4): заголовок «Ход N · модель · латентность · ток · ₽»
  // + флаг рельсы; шаги одной строкой, свёрнуты по умолчанию.
  // data-turn-id — связка с ассистент-баблом диалога (linked scroll P2).
  import type { TurnBlock as TurnBlockData } from "../stores/trace.svelte";
  import StepChip from "./StepChip.svelte";
  import { fmtRub, fmtSec, fmtTok } from "../format";

  let {
    turn,
    index,
    open,
    ontoggle,
    focused = false,
  }: { turn: TurnBlockData; index: number; open: boolean; ontoggle: () => void; focused?: boolean } = $props();

  // (г, cust-fix 10.10): живой таймер pending-хода — тикает на клиенте каждую
  // секунду (⏱ N с в заголовке): серверные step-события замирают, пока
  // CPU-реранкер блокирует event-loop сервера.
  let elapsed = $state(0);
  $effect(() => {
    if (!turn.pending || !turn.startedAtMs) return;
    const update = () => {
      elapsed = Math.round((Date.now() - turn.startedAtMs!) / 1000);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  });
</script>

<div class="turn" class:focused data-turn-id={turn.turnId}>
  <button type="button" class="tsummary" onclick={ontoggle} aria-expanded={open} title={open ? "Свернуть шаги" : "Показать внутренние шаги"}>
    <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="tno">Ход {index}</span>
    <span class="tlabel">{turn.userText.slice(0, 44)}</span>
    {#if turn.railViolated}
      <span class="rail" title="Рельса «RAG каждый ход + источники» нарушена">рельса ✕</span>
    {/if}
    {#if turn.pending}
      <span class="tm" title="Ход выполняется — время с отправки вопроса">
        ⏱ {elapsed} с
      </span>
    {:else}
      <span class="tm">
        {turn.model} · {fmtSec(turn.latencyMs)} · {fmtTok(turn.tokens)} ток · {fmtRub(turn.costRub)}
      </span>
    {/if}
  </button>
  {#if open}
    <div class="steps">
      {#if turn.restored && turn.steps.length === 0}
        <div class="restored-note">
          Ход восстановлен из истории сессии — пошаговые детали (rag/цитаты/рельса) живут
          только вживую и в кэше вкладки, на сервере не сохраняются.
        </div>
      {/if}
      {#each turn.steps as s (s.id)}
        <StepChip step={s} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .turn {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-2);
  }
  /* P2: «ход в фокусе» — подсветка якоря связного скролла (D-2). */
  .turn.focused {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft), var(--shadow-2);
  }
  .chev {
    color: var(--muted);
    font-size: 11px;
    flex: none;
    width: 14px;
    text-align: center;
  }
  .tsummary {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    cursor: pointer;
    font: 600 12.5px/1 system-ui, sans-serif;
    border: 0;
    background: none;
    color: var(--ink);
    text-align: left;
  }
  .tno {
    background: var(--chip);
    border-radius: 6px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  .tlabel {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .rail {
    color: var(--danger);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 1px 6px;
    font: 600 10.5px/1.6 system-ui, sans-serif;
    white-space: nowrap;
  }
  .tm {
    color: var(--muted);
    font-weight: 500;
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
  }
  .steps {
    border-top: 1px solid var(--line);
    padding: 6px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .restored-note {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
    padding: 4px 2px;
  }
</style>
