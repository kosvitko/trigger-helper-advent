<script lang="ts">
  // Бабл диалога (D-3): пользователь справа/accent, ассистент слева/surface.
  // data-turn-id — связка с блоком трейса (P2). Ассистент-бабл —
  // постпроцессинг: метки источников убраны (они в SourcesChip),
  // маркдаун отрендерен (жирное → жирное, заголовки → заголовки).
  // Кликовая синхронизация (Костя 04.10): клик по ассистент-баблу —
  // обе колонки ставят этот ход на линию фокуса.
  import type { AgentMessage } from "@trigger-helper/shared";
  import { renderReply } from "../markdown";

  let { message, onalign }: { message: AgentMessage; onalign?: () => void } = $props();
</script>

{#if message.role === "user"}
  <div class="msg user">{message.content}</div>
{:else}
  <div
    class="msg bot"
    data-turn-id={message.id}
    class:linked={!!onalign}
    onclick={onalign ?? (() => undefined)}
    onkeydown={(e: KeyboardEvent) => {
      if (!onalign) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onalign();
      }
    }}
    role="button"
    tabindex={0}
    title={onalign ? "Показать ход в трейсе" : undefined}
  >{@html renderReply(message.content)}</div>
{/if}

<style>
  .msg {
    max-width: min(75ch, 78%);
    padding: 10px 14px;
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-2);
    font-size: 16px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.bot {
    align-self: flex-start;
    background: var(--surface);
    border-bottom-left-radius: 4px;
    white-space: normal;
  }
  .msg.bot.linked {
    cursor: pointer;
  }
  /* Маркдаун-стили внутри ассистент-бабла */
  .msg.bot :global(h2) { font: 700 18px/1.3 system-ui, sans-serif; margin: 12px 0 6px; }
  .msg.bot :global(h3) { font: 700 16px/1.3 system-ui, sans-serif; margin: 10px 0 4px; }
  .msg.bot :global(h4) { font: 600 14px/1.3 system-ui, sans-serif; margin: 8px 0 4px; }
  .msg.bot :global(strong) { color: var(--accent-deep); }
  .msg.bot :global(ul) { margin: 6px 0; padding-left: 20px; }
  .msg.bot :global(li) { margin: 3px 0; }
  .msg.bot :global(hr) { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
  .msg.bot :global(p) { margin: 4px 0; }
</style>
