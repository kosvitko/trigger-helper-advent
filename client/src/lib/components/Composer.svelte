<script lang="ts">
  // Композер (D-3): минимален — textarea + model-chip + send.
  import { dialog } from "../stores/dialog.svelte";
  import { session } from "../stores/session.svelte";
  import ModelChip from "./ModelChip.svelte";

  let text = $state("");

  async function send(): Promise<void> {
    const t = text.trim();
    if (!t || dialog.typing) return; // busy-guard: повторный клик/Enter не стреляет
    text = ""; // очистка МГНОВЕННО (как в старом UI) — бабл уже в ленте, typing-индикатор виден
    await dialog.send(t); // typing=true синхронно → кнопка «Отправляем…» сразу
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="comp">
  <textarea
    id="composer-input"
    bind:value={text}
    onkeydown={onkeydown}
    placeholder="Опишите, что болит — найдём точки и подскажем самопомощь"
    rows="2"
  ></textarea>
  <div class="row">
    <ModelChip />
    <div class="sp"></div>
    <button
      type="button"
      id="composer-send"
      class="send"
      disabled={dialog.typing || !session.activeAgentId}
      title={session.activeAgentId ? undefined : "Нет активной сессии — создайте RAG-чат в шапке"}
      onclick={() => void send()}
    >
      {dialog.typing ? "Отправляем…" : "Отправить"}
    </button>
  </div>
</div>

<style>
  .comp {
    margin: 8px 20px 16px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    padding: 10px 12px;
    box-shadow: var(--shadow-2);
  }
  textarea {
    width: 100%;
    border: 0;
    resize: none;
    font: 14px/1.5 system-ui, sans-serif;
    background: transparent;
    color: var(--ink);
    outline: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .sp {
    flex: 1;
  }
  .send {
    border: 0;
    background: var(--accent);
    color: #fff;
    border-radius: 999px;
    padding: 8px 18px;
    font: 600 13px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .send:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
