<script lang="ts">
  // Чип «Источники (N) · цитаты M/M ✓» (D-3): свёрнут по умолчанию;
  // раскрытие — карточки цитат с [source › section] и признаком верификации.
  import type { TurnBlock } from "../stores/trace.svelte";

  let { turn, reply }: { turn: TurnBlock; reply: string } = $props();

  // Эфемерный UI-стейт (F-2) — переживает любые merge данных.
  let open = $state(false);

  let rag = $derived(turn.steps.find((s) => s.kind === "rag")?.data.rag ?? null);
  // dontKnow-ходы чип не показывают (мок: источник нет — «не знаю» без чипа)
  let shown = $derived(rag && !rag.dontKnow && rag.sourcesCount > 0 ? rag : null);

  /** Метка как в рельсе: [source › section] (server ragSourceLabel). */
  function quoteLabel(q: { source: string; section: string }): string {
    return `[${q.source} › ${q.section || "—"}]`;
  }
  let verified = $derived(
    shown ? shown.quotes.filter((q) => reply.includes(quoteLabel(q))).length : 0,
  );
</script>

{#if shown}
  <div class="wrap">
    <button type="button" class="src-chip" onclick={() => (open = !open)}>
      Источники&nbsp;<i>{shown.sourcesCount}</i>&nbsp;· цитаты&nbsp;<i
        >{verified}/{shown.quotesCount}{verified === shown.quotesCount ? " ✓" : ""}</i
      >
    </button>
    {#if open}
      <div class="quotes">
        {#each shown.quotes as q, i (i)}
          <div class="qcard">
            <p>«{q.quote}»</p>
            <span class="qlabel {reply.includes(quoteLabel(q)) ? 'ok' : ''}"
              >{quoteLabel(q)} {reply.includes(quoteLabel(q)) ? "✓ в ответе" : "— не в ответе"}</span
            >
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .src-chip {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    background: var(--accent-soft);
    color: var(--accent);
    border: 0;
    border-radius: 999px;
    padding: 5px 12px;
    font: 600 12px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .src-chip i {
    font-style: normal;
    background: var(--surface);
    border-radius: 999px;
    padding: 2px 7px;
  }
  .quotes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: min(75ch, 90%);
  }
  .qcard {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-2);
    padding: 8px 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .qcard p {
    margin: 0 0 4px;
    color: var(--ink);
    line-height: 1.5;
  }
  .qlabel {
    font: 600 12px/1 system-ui, sans-serif;
    color: var(--muted);
  }
  .qlabel.ok {
    color: var(--accent-deep);
  }
</style>
