<script module lang="ts">
  // Хелпер шаблона: блок трейса этого хода (может не быть — не-rag агент).
  import { trace } from "../stores/trace.svelte";
  import type { TurnBlock } from "../stores/trace.svelte";

  export function turnOf(id: string): TurnBlock | null {
    return trace.turnBy(id);
  }
</script>

<script lang="ts">
  // Продуктовая колонка (D-3): лента баблов + «Память задачи» + композер.
  // Телеметрии на лице нет — счётчики/₽ уходят в трейс и настройки.
  import { getChatPreset } from "@trigger-helper/shared";
  import MessageBubble from "./MessageBubble.svelte";
  import SourcesChip from "./SourcesChip.svelte";
  import Composer from "./Composer.svelte";
  import { dialog } from "../stores/dialog.svelte";
  import { session } from "../stores/session.svelte";
  import { settings } from "../stores/settings.svelte";
  // trace уже в скоупе из module-script (turnOf) — без повторного импорта.

  /** Кликовая синхронизация (Костя 04.10): клик по ассистент-баблу хода —
  *  обе колонки ставят ход на линию фокуса. */
  let { onalign }: { onalign?: (turnId: string) => void } = $props();

  let messages = $derived(dialog.ordered);
  // C+ CH-5b: дефолт-модель агента умерла вместе с серверными агентами;
  // правда для чипа — последний живой ход (QA 041003 F3).
  let currentModel = $derived(
    settings.overrides.model ?? trace.lastLiveModel() ?? "deepseek-chat",
  );
  let threadLabel = $derived.by(() => {
    const t = session.activeThread;
    if (!t) return "RAG-чат";
    return t.title || getChatPreset(t.preset)?.label || t.preset;
  });

  // Автоскролл ленты вниз (новое сообщение/typing — единственные триггеры).
  // Stick-to-bottom (Костя, 15.10): дёргаем вниз только ленту, стоявшую у
  // нижнего края — уехавшего читать историю автоскролл не отматывает;
  // возврат к краю возвращает автоскролл. Смена треда — всегда к хвосту.
  let feedEl = $state<HTMLDivElement | null>(null);
  let stick = true;
  const STICK_EPS_PX = 24;

  function onFeedScroll(): void {
    if (!feedEl) return;
    stick = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - STICK_EPS_PX;
  }

  $effect(() => {
    void session.activeThreadId; // новый тред — лента стартует у хвоста
    stick = true;
  });

  $effect(() => {
    void dialog.messages.size;
    void dialog.typing;
    void dialog.queueStatus;
    // Cust-fix 261015-7 (репорт Кости по д34): своя отправка — не «чтение
    // истории»: последняя реплика от юзера ⇒ всегда к хвосту (своё сообщение
    // и typing должны быть в кадре). Ответ ассистента растёт дальше — только
    // если юзер не уехал читать выше (правило stick-to-bottom д33 не трогаем).
    const last = dialog.ordered.at(-1);
    if (last && last.role === "user") stick = true;
    if (feedEl && stick) feedEl.scrollTop = feedEl.scrollHeight;
  });
</script>

<div class="col-h">
  Диалог
  <span class="meta">{threadLabel} · {currentModel}</span>
</div>

<div class="feed" bind:this={feedEl} onscroll={onFeedScroll} data-feed>
  {#if messages.length === 0 && !dialog.typing}
    <div class="empty">Опишите, что болит — найдём точки и подскажем самопомощь</div>
  {/if}
  {#each messages as m (m.id)}
    {#if m.role === "system"}
      <!-- Системные сводки (сжатие/стадии) персистятся в треде (D-4) — одна строка. -->
      <div class="sysmsg">{m.label ?? "сводка"} · {m.content.slice(0, 140)}</div>
    {:else if m.role === "assistant"}
      {@const t = turnOf(m.id)}
      <MessageBubble message={m} onalign={t ? () => onalign?.(m.id) : undefined} />
      {#if t}
        <SourcesChip turn={t} reply={m.content} />
      {/if}
    {:else}
      <MessageBubble message={m} />
    {/if}
  {/each}
  {#if dialog.typing}
    <div
      class="msg bot typing"
      class:queue={!!dialog.queueStatus}
      aria-label={dialog.queueStatus ?? "Модель отвечает"}
    >{dialog.queueStatus ?? "…"}</div>
  {/if}
</div>

<Composer />

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
  .col-h .meta {
    margin-left: auto;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
  }
  .feed {
    flex: 1;
    overflow: auto;
    padding: 6px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .empty {
    margin: auto;
    max-width: 46ch;
    text-align: center;
    color: var(--muted);
    font-size: 15px;
  }
  .msg {
    max-width: min(75ch, 78%);
    padding: 10px 14px;
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-1);
    font-size: 16px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.bot {
    align-self: flex-start;
    background: var(--surface);
    border-bottom-left-radius: 4px;
  }
  .msg.typing {
    color: var(--muted);
  }
  /* День 30: статус очереди — читаемый статус, не «мигающие точки». */
  .msg.typing.queue {
    color: var(--ink);
    font-style: italic;
  }
  .sysmsg {
    align-self: center;
    max-width: 90%;
    color: var(--muted);
    font-size: 12.5px;
    background: var(--chip);
    border-radius: 999px;
    padding: 3px 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
