<script lang="ts">
  // Шаг хода (D-4): кликабельная строка → раскрывается в детальную карточку.
  // Обогащение 031003: карточка показывает СТРУКТУРНЫЕ данные шага
  // (llm: модель/токены/фрагмент ответа; память: факты по слоям;
  // память задачи: экстракт; сжатие: до/после; rag: цитаты),
  // а не повтор короткой строки.
  import type { TraceStep } from "../stores/trace.svelte";
  import { fmtRub, fmtTok } from "../format";

  let { step }: { step: TraceStep } = $props();

  let open = $state(false);

  const icons: Record<string, string> = {
    rag: "🔎",
    llm: "🧠",
    memory: "💾",
    compress: "✂️",
    gate: "⛔",
    fsm: "⚙️",
    payload: "📎",
    tool: "🔧",
  };

  let rag = $derived(step.data.rag ?? null);
  let llm = $derived(step.data.llm ?? null);
  let mem = $derived(step.data.memory ?? null);
  let task = $derived(step.data.task ?? null);
  let comp = $derived(step.data.compress ?? null);
  /** Варианты рерайта (подшаг rag_ask, Костя 041004). */
  let variants = $derived(step.data.variants ?? null);

  /** Есть ли что раскрывать: только при структурных данных шага. */
  let expandable = $derived(
    rag !== null || llm !== null || mem !== null || task !== null || comp !== null || variants !== null,
  );
</script>

<div class="step-wrap" class:ok={rag ? rag.ok && !rag.dontKnow : step.kind === "llm"}>
  <button type="button" class="steprow" onclick={() => expandable && (open = !open)} aria-expanded={expandable ? open : undefined} class:clickable={expandable}>
    <span class="chev" aria-hidden="true">{expandable ? (open ? "▾" : "▸") : ""}</span>
    <span class="ico">{icons[step.kind] ?? "·"}</span>
    <span class="what">{step.title}</span>
    <span class="sub">{step.data.sub}</span>
    <span class="cost">{step.data.cost}</span>
  </button>
  {#if open && expandable}
    <div class="deep">
      {#if rag}
        {#if rag.error}
          Ошибка вызова: <b>{rag.error}</b>
        {:else if rag.dontKnow}
          Ничего релевантного — <b>dontKnow</b> · косинус top-1
          {rag.topCosine !== null ? rag.topCosine.toFixed(3) : "—"} · источников не приводим
        {:else}
          <b>Запрос:</b> {rag.question}<br />
          Найдено <b>{rag.sourcesCount} источников</b>
          {rag.topCosine !== null ? ` · top-1 косинус ${rag.topCosine.toFixed(3)}` : ""}
          {rag.threshold !== null && rag.threshold !== undefined ? ` · порог ${rag.threshold}` : ""}
          · цитат <b>{rag.quotesCount}</b>
          {rag.latencyMs !== null ? ` · ${Math.round(rag.latencyMs)} мс` : ""}
          {#if rag.labels.length}
            <br /><b>Источники:</b> {rag.labels.join(" · ")}
          {/if}
        {/if}
        {#if rag.quotes.length}
          <div class="grp">Цитаты ({rag.quotesCount}):</div>
          <ul class="qlist">
            {#each rag.quotes.slice(0, 8) as q}
              <li>«{q.quote}»
                <span class="src">[{q.source}{q.section ? ` › ${q.section}` : ""}]</span></li
              >
            {/each}
          </ul>
          {#if rag.quotes.length > 8}
            <div class="more">… и ещё {rag.quotes.length - 8}</div>
          {/if}
        {/if}
      {:else if llm}
        <b>{llm.model}</b> · {Math.round(llm.latencyMs)} мс · {fmtRub(llm.costRub)}<br />
        <b>Токены:</b> промпт {fmtTok(llm.prompt)} (кэш-хит {fmtTok(llm.cacheHit)}) · ответ
        {fmtTok(llm.completion)} · всего {fmtTok(llm.total)}
        <div class="clip">{llm.replyClip}</div>
      {:else if mem}
        {#if mem.long.length}
          <div class="grp">Долговременные ({mem.long.length}):</div>
          <ul class="qlist">
            {#each mem.long as f}<li>{f}</li>{/each}
          </ul>
        {/if}
        {#if mem.working.length}
          <div class="grp">Рабочие ({mem.working.length}):</div>
          <ul class="qlist">
            {#each mem.working as f}<li>{f}</li>{/each}
          </ul>
        {/if}
        {#if mem.short.length}
          <div class="grp">Краткосрочные ({mem.short.length}):</div>
          <ul class="qlist">
            {#each mem.short as f}<li>{f}</li>{/each}
          </ul>
        {/if}
        {#if mem.classifyTokens !== null}
          <div class="grp">Классификация фактов: {fmtTok(mem.classifyTokens)} ток</div>
        {/if}
        {#if !mem.long.length && !mem.working.length && !mem.short.length && mem.classifyTokens === null}
          Слои пусты — факты не инжектированы.
        {/if}
      {:else if task}
        {#if task.goal}
          <div class="grp">Цель:</div>
          <div>{task.goal}</div>
        {/if}
        {#if task.clarified.length}
          <div class="grp">Уточнено ({task.clarified.length}):</div>
          <ul class="qlist">
            {#each task.clarified as c}<li>{c}</li>{/each}
          </ul>
        {/if}
        {#if task.constraints.length}
          <div class="grp">Ограничения ({task.constraints.length}):</div>
          <ul class="qlist">
            {#each task.constraints as c}<li>{c}</li>{/each}
          </ul>
        {/if}
        {#if !task.goal && !task.clarified.length && !task.constraints.length}
          Экстракт пуст — ход ничего нового не зафиксировал.
        {/if}
      {:else if variants}
        <b>Варианты запроса к базе:</b>
        <ul class="qlist">
          {#each variants as v, i}
            <li>{i + 1}. «{v}»</li>
          {/each}
        </ul>
      {:else if comp}
        <b>{comp.model}</b> · {Math.round(comp.latencyMs)} мс · {fmtRub(comp.costRub)}<br />
        Окно: {comp.beforeCount} сообщ. ({fmtTok(comp.beforeTokens)}) → {comp.afterCount} сообщ.
        ({fmtTok(comp.afterTokens)})<br />
        <b>Сэкономлено:</b> {fmtTok(comp.savedTokens)} ток
      {:else}
        {step.data.sub} · {step.data.cost}
      {/if}
    </div>
  {/if}
</div>

<style>
  .step-wrap {
    display: flex;
    flex-direction: column;
    border-radius: 8px;
    font-size: 12.5px;
    min-width: 0;
  }
  .step-wrap:hover {
    background: var(--chip);
  }
  .steprow {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: 0;
    background: none;
    padding: 6px 8px;
    border-radius: 8px;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .steprow.clickable {
    cursor: pointer;
  }
  .chev {
    color: var(--muted);
    font-size: 10px;
    width: 12px;
    flex: none;
    text-align: center;
  }
  .ico {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    background: var(--chip);
    font-size: 11px;
    flex: none;
  }
  .step-wrap.ok .ico {
    background: var(--accent-soft);
  }
  .what {
    font-weight: 600;
    white-space: nowrap;
    flex: none;
  }
  .sub {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .cost {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-size: 11.5px;
    flex: none;
  }
  .deep {
    margin: 2px 8px 6px 26px;
    padding: 8px 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
    overflow-wrap: break-word;
    word-break: break-word;
    max-width: calc(100% - 34px);
    min-width: 0;
  }
  .deep :global(b) {
    color: var(--ink);
  }
  .grp {
    font-weight: 600;
    color: var(--ink);
    margin-top: 6px;
  }
  .deep .qlist {
    margin: 2px 0 0;
    padding-left: 16px;
  }
  .deep .qlist li {
    margin: 2px 0;
  }
  .deep .src {
    color: var(--muted);
  }
  .clip {
    margin-top: 6px;
    padding: 6px 8px;
    background: var(--chip);
    border-radius: 6px;
    font-style: italic;
    white-space: pre-wrap;
  }
  .more {
    color: var(--muted);
    margin-top: 2px;
  }
</style>
