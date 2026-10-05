<script lang="ts">
  // Оболочка (D-2/D-6): topbar + постоянный двухтрековый грид.
  // Раскладка — эфемерный UI-стейт (F-2), живёт здесь, не в сторах.
  import { onMount } from "svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import DialogColumn from "./DialogColumn.svelte";
  import TraceColumn from "./TraceColumn.svelte";
  import SettingsScreen from "./SettingsScreen.svelte";
  import { session } from "../stores/session.svelte";
  import { dialog } from "../stores/dialog.svelte";
  import { settings } from "../stores/settings.svelte";
  import { trace } from "../stores/trace.svelte";
  import { linkScroll } from "../scroll-sync";
  import type { ViewMode } from "../types";

  let mode = $state<ViewMode>("both");
  let showSettings = $state(false);
  /** P2: ход на линии фокуса связного скролла (индикатор в трейсе). */
  let focusTurnId = $state<string | null>(null);
  let colsEl = $state<HTMLElement | null>(null);

  /** Агент, чей тред уже в ленте: один lifecycle-путь на boot/switch/создание —
   *  ни один обработчик не может «забыть» сбросить ленту/трейс (баги 1–2). */
  let loadedAgentId: string | null | undefined = undefined;

  onMount(() => {
    // Модели для чипа — в фоне; стартовая сессия — блокирует диалог.
    settings.loadModels().catch(() => undefined);
    void boot();
  });

  async function boot(): Promise<void> {
    try {
      await session.ensureActive();
    } catch (e) {
      session.error = errMsg(e);
    }
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // Смена активного агента (boot / выбор в шапке / + RAG-чат) → скоуп трейса
  // + перезагрузка треда. loadThread сам очищает ленту до загрузки.
  $effect(() => {
    const agentId = session.activeAgentId;
    if (agentId === loadedAgentId) return;
    if (agentId === null && loadedAgentId === undefined) return; // до boot — тишина
    loadedAgentId = agentId;
    trace.setScope(agentId);
    void dialog
      .loadThread()
      .then(() => {
        session.error = "";
      })
      .catch((e: unknown) => {
        session.error = errMsg(e);
      });
  });

  // P2 (D-2): связный скролл диалог ↔ трейс — якорь data-turn-id,
  // leader-by-intent, программный скролл ведомого под guard (scroll-sync.ts).
  // Переподключается при возврате из настроек (грид пересоздаётся).
  // Кликовая синхронизация (Костя 04.10): клик по ходу/баблу — alignTo.
  let alignToFn = $state<((turnId: string) => void) | null>(null);
  $effect(() => {
    if (showSettings || !colsEl) return;
    const feed = colsEl.querySelector<HTMLElement>("[data-feed]");
    const traceBox = colsEl.querySelector<HTMLElement>("[data-trace]");
    if (!feed || !traceBox) return;
    const link = linkScroll(feed, traceBox, {
      onTurnFocus: (id) => (focusTurnId = id),
    });
    alignToFn = (turnId: string) => link.alignTo(turnId);
    return () => link.dispose();
  });
</script>

<header class="top">
  <div class="brand">Trigger Helper <small>самопомощь при мышечной боли</small></div>
  <SegmentedControl bind:value={mode} />
  <div class="sp"></div>
  <select
    class="icon-btn session"
    title="Активный чат (сессия → чат)"
    value={session.activeChatValue}
    onchange={(e) => {
      const v = (e.currentTarget as HTMLSelectElement).value;
      const sep = v.indexOf(":");
      if (sep > 0) session.selectChat(v.slice(0, sep), v.slice(sep + 1));
    }}
  >
    {#if !session.instances.length}
      <option value="">Сессий нет</option>
    {:else if !session.activeChatValue}
      <option value="" disabled hidden>Выберите чат…</option>
    {/if}
    {#each session.instances as inst (inst.id)}
      <optgroup label={inst.label}>
        {#each inst.agents as a (a.id)}
          <option value={`${inst.id}:${a.id}`}>{a.label}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <button id="close-chat" class="icon-btn close-btn" disabled={!session.canCloseAgent} title={session.canCloseAgent ? "Закрыть активный чат (5 с на «Вернуть»)" : "Нельзя закрыть последнего агента — закройте сессию"} onclick={() => void session.closeActiveAgent().catch((e) => (session.error = errMsg(e)))}>
    ✕ чат
  </button>
  <button id="close-session" class="icon-btn close-btn" disabled={!session.canCloseInstance} title={session.canCloseInstance ? "Закрыть сессию целиком (5 с на «Вернуть»)" : "Нельзя закрыть последнюю сессию"} onclick={() => void session.closeActiveInstance().catch((e) => (session.error = errMsg(e)))}>
    ✕ сессия
  </button>
  <button id="new-rag-chat" class="icon-btn" title="Создать сессию RAG-чата одним кликом" onclick={() => void session.createRagChat().catch((e) => (session.error = errMsg(e)))}>
    + RAG-чат
  </button>
  <button
    class="icon-btn"
    class:active-btn={showSettings}
    title="Настройки"
    onclick={() => (showSettings = !showSettings)}
  >
    {showSettings ? "◂ К диалогу" : "⚙ Настройки"}
  </button>
</header>

{#if session.error || dialog.error}
  <div class="err" role="alert">{session.error || dialog.error}</div>
{/if}

{#if session.undo}
  <div class="undo" role="status">
    <span>{session.undo.text}</span>
    <button type="button" onclick={() => void session.undoClose()}>Вернуть</button>
  </div>
{/if}

{#if showSettings}
  <SettingsScreen />
{:else}
  <main class="cols" class:only-dialog={mode === "dialog"} class:only-trace={mode === "trace"} bind:this={colsEl}>
    <section class="col dialog-col"><DialogColumn onalign={(id) => alignToFn?.(id)} /></section>
    <section class="col trace-col"><TraceColumn focusedTurnId={focusTurnId} onalign={(id) => alignToFn?.(id)} /></section>
  </main>
{/if}

<!-- Юридический футер (аудит 261004-legal-audit + 261004-copyright-audit:
     MUST/SHOULD на каждом экране; пересказ-декларация и не-аффилированность) -->
<footer class="legal">
  Образовательный сервис самопомощи · не медицинская организация, медицинских услуг не оказывает ·
  ответы ИИ основаны на пересказе клинической литературы о триггерных точках (Дж. Травелл, Д. Саймонс; Д. Дэвис) —
  это не цитаты и не официальные издания, правообладатели с сервисом не связаны · без диагнозов и назначений ·
  при острой или нарастающей боли, онемении, травме, температуре — обратитесь к врачу
</footer>

<style>
  .top {
    display: flex;
    align-items: center;
    /* Узкие экраны/мобильные: контролы переносятся на следующие строки
       (замечание Кости 04.10 — шапка не сжималась по ширине) */
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    font-weight: 700;
    font-size: 16px;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
  .brand small {
    color: var(--muted);
    font-weight: 500;
    margin-left: 8px;
    font-size: 12px;
  }
  .sp {
    flex: 1;
  }
  .icon-btn {
    border: 1px solid var(--line);
    background: var(--surface);
    border-radius: 10px;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }
  .icon-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .icon-btn.active-btn {
    background: var(--accent);
    color: var(--surface);
    border-color: var(--accent);
  }
  .close-btn:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .close-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* Тост «закрыто · Вернуть» — паритет со старым UI (UNDO_MS = 5 с). */
  .undo {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    display: flex;
    gap: 12px;
    align-items: center;
    background: var(--warm-soft);
    color: var(--warm);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-2);
    border-radius: 999px;
    padding: 8px 10px 8px 16px;
    font-size: 13px;
    z-index: 40;
  }
  .undo button {
    border: 0;
    background: var(--warm);
    color: #fff;
    border-radius: 999px;
    padding: 6px 14px;
    font: 600 12.5px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .session {
    max-width: 220px;
  }
  .err {
    padding: 8px 20px;
    background: var(--warm-soft);
    color: var(--warm);
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  /* Постоянный 2-трековый грид (05-M-2): интерполируем доли, не число треков.
     «Схлопнуть/раздвинуться» — transition ширины (требование заказчика, D-2). */
  .cols {
    flex: 1;
    display: grid;
    grid-template-columns: 55fr 45fr;
    min-height: 0;
    transition: grid-template-columns 0.3s ease;
  }
  .cols.only-dialog {
    grid-template-columns: 100fr 0fr;
  }
  .cols.only-trace {
    grid-template-columns: 0fr 100fr;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .trace-col {
    border-left: 1px solid var(--line);
  }
  /* QA 041003 (F4): у схлопнутой колонки бордер рисовал 1px-полосу на краю
     экрана — разделитель нужен только в режиме «Оба». */
  .cols.only-dialog .trace-col,
  .cols.only-trace .trace-col {
    border-left: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .cols {
      transition: none;
    }
  }
  /* Юридический футер: на узких экранах текст переносится, не обрезается */
  .legal {
    flex: none;
    padding: 3px 12px;
    border-top: 1px solid var(--line);
    background: var(--surface);
    color: var(--muted);
    font: 500 11px/1.5 system-ui, sans-serif;
    text-align: center;
    overflow-wrap: anywhere;
  }
</style>
