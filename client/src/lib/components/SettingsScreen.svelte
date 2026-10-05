<script lang="ts">
  // Экран настроек (D-5): 4 секции — только консолидация существующих ручек.
  // Модель / Контекст и память / Поиск по базе / Агенты и сессии.
  import { settings } from "../stores/settings.svelte";
  import { api } from "../api";

  let models = $state<{ model: string; label: string; via: string }[]>([]);
  let ragStats = $state<Awaited<ReturnType<typeof api.ragStats>> | null>(null);
  /** Серверный дефолт автосжатия (AGENT_COMPRESS_EVERY) — фолбэк для поля. */
  let compressDefault = $state<number | null>(null);
  let openSection = $state("model"); // какая секция раскрыта

  /** Тема оформления: «» — системная, light/dark — ручное закрепление
   *  (Костя 051005: «видел тёмную, не понял, как включать самому»). */
  let theme = $state(document.documentElement.dataset.theme ?? "");

  function setTheme(v: string): void {
    theme = v;
    if (v === "dark" || v === "light") {
      document.documentElement.dataset.theme = v;
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      if (v) localStorage.setItem("th.theme", v);
      else localStorage.removeItem("th.theme");
    } catch {
      /* приватный режим — тема живёт до перезагрузки */
    }
  }

  // Загрузка списка моделей и RAG-статистики
  $effect(() => {
    void (async () => {
      try {
        const res = await api.getModels();
        models = res.models.map((m) => ({ model: m.model, label: m.label, via: m.via }));
      } catch { /* fail-open: пустой список — дефолт agenta */ }
      try {
        ragStats = await api.ragStats();
      } catch { /* read-only, сбой не критичен */ }
      try {
        compressDefault = (await api.agentsMeta()).autoCompress?.defaultEvery ?? null;
      } catch { /* дефолт неизвестен — поле с placeholder */ }
    })();
  });

  const sections = [
    { id: "model", label: "Модель", icon: "🧠" },
    { id: "context", label: "Контекст и память", icon: "📚" },
    { id: "search", label: "Поиск по базе", icon: "🔎" },
    { id: "interface", label: "Интерфейс", icon: "🎨" },
  ];
</script>

<div class="settings">
  <nav class="nav">
    <h3>Настройки</h3>
    {#each sections as s (s.id)}
      <button
        type="button"
        class="nav-item"
        class:active={openSection === s.id}
        onclick={() => (openSection = s.id)}
      >
        {s.icon} {s.label}
      </button>
    {/each}
  </nav>

  <div class="content">
    {#if openSection === "model"}
      <h2>Модель</h2>
      <p class="sub">Влияет на все новые ходы; текущий ход не прерывается.</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Модель ответов</b><span>Генерирует нарратив поверх найденного</span></div>
          <select bind:value={settings.overrides.model} onchange={() => settings.persist()}>
            <option value="">по умолчанию агента</option>
            {#each models as m (m.model)}
              <option value={m.model}>{m.label} · {m.model}</option>
            {/each}
          </select>
        </div>
        <div class="row">
          <div class="lbl"><b>Жёсткая рельса источников</b><span>Каждый ответ обязан опираться на rag_ask и перечислять источники</span></div>
          <button
            type="button"
            class="toggle"
            class:on={settings.overrides.tools !== false}
            role="switch"
            aria-checked={settings.overrides.tools !== false}
            aria-label="Жёсткая рельса источников"
            onclick={() => {
              settings.overrides.tools = settings.overrides.tools === false ? true : false;
              settings.persist();
            }}
          ></button>
        </div>
      </div>
    {:else if openSection === "context"}
      <h2>Контекст и память</h2>
      <p class="sub">Стратегии работы с историей диалога (день 10) и автосжатие (день 09).</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Стратегия истории</b><span>Как хранится контекст между ходами</span></div>
          <select bind:value={settings.overrides.contextStrategy} onchange={() => settings.persist()}>
            <option value="">по умолчанию агента</option>
            <option value="sliding">Скользящее окно</option>
            <option value="facts">Факты</option>
            <option value="branching">Ветвление</option>
          </select>
        </div>
        <div class="row">
          <div class="lbl"><b>Автосжатие каждые N сообщений</b><span>0 = выключено; экономия токенов на длинных диалогах{compressDefault !== null ? ` · по умолчанию сервера: ${compressDefault}` : ""}</span></div>
          <input
            type="number"
            min="0"
            max="50"
            value={settings.overrides.compressEvery ?? compressDefault ?? ""}
            onchange={(e) => {
              settings.overrides.compressEvery = Number((e.currentTarget as HTMLInputElement).value);
              settings.persist();
            }}
            style="width:100px"
          />
        </div>
      </div>
    {:else if openSection === "search"}
      <h2>Поиск по базе</h2>
      <p class="sub">Продукт ищет по индексу «structured» (замер дня 22: hit@1 0.67 против 0.50 у fixed — единственный режим, где RAG повышает качество). Индекс «fixed» хранится как база сравнения для контрольных прогонов.</p>

      <div class="card">
        {#if ragStats?.ok}
          {#each ragStats.indexes as ix (ix.strategy)}
            <div class="row">
              <div class="lbl">
                <b>Индекс «{ix.strategy}»</b>
                <span>{ix.chunks} чанков · {ix.fileCount} файлов · {ix.model}{ix.builtAt ? ` · собран ${new Date(ix.builtAt).toLocaleDateString("ru-RU")}` : ""}</span>
              </div>
              {#if ix.avgChars !== undefined}
                <span class="value">≈{ix.avgChars} симв./чанк</span>
              {/if}
            </div>
          {/each}
          {#if ragStats.compare}
            <div class="row">
              <div class="lbl">
                <b>Контрольные прогоны</b>
                <span>hit@1 / hit@5 / MRR по стратегиям</span>
              </div>
              <span class="value">
                {#each Object.entries(ragStats.compare.byStrategy) as [name, m] (name)}
                  {name}: {m.hitAt1?.toFixed(2) ?? "—"}/{m.hitAt5?.toFixed(2) ?? "—"}/{m.mrr?.toFixed(2) ?? "—"}&nbsp;&nbsp;
                {/each}
              </span>
            </div>
          {/if}
        {:else}
          <div class="row"><div class="lbl"><b>Статистика недоступна</b><span>Сервер не отвечает или формат изменился</span></div></div>
        {/if}
      </div>
    {:else if openSection === "interface"}
      <h2>Интерфейс</h2>
      <p class="sub">Тема подбирается по настройкам устройства; можно закрепить вручную.</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Тема оформления</b><span>Системная — следует устройству; светлая/тёмная — закрепить за этим браузером</span></div>
          <select value={theme} onchange={(e) => setTheme((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">Системная</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </div>
      </div>
  {/if}
</div>
</div>

<style>
  .settings {
    flex: 1;
    display: grid;
    grid-template-columns: 220px 1fr;
    min-height: 0;
    background: var(--bg);
  }
  .nav {
    padding: 20px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-right: 1px solid var(--line);
    background: var(--surface);
  }
  .nav h3 {
    font: 600 11px/1 system-ui, sans-serif;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin: 0 10px 10px;
  }
  .nav-item {
    padding: 9px 12px;
    border: 0;
    border-radius: 10px;
    color: var(--ink);
    background: none;
    font: 600 13px/1 system-ui, sans-serif;
    cursor: pointer;
    text-align: left;
  }
  .nav-item:hover { background: var(--chip); }
  .nav-item.active { background: var(--accent-soft); color: var(--accent); }
  .content { padding: 26px clamp(20px, 6%, 72px); overflow: auto; }
  h2 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-2);
    padding: 16px 18px;
    margin-bottom: 14px;
    max-width: 720px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .row:last-child { border-bottom: 0; }
  .lbl { flex: 1; }
  .lbl b { display: block; font-size: 14px; }
  .lbl span { color: var(--muted); font-size: 12.5px; }
  .value { color: var(--muted); font-weight: 600; font-size: 13px; }
  select, input[type="number"] {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 12px;
    font: 13px system-ui, sans-serif;
    background: var(--surface);
    min-width: 200px;
    color: var(--ink);
  }
  .toggle {
    width: 40px; height: 22px; border-radius: 999px;
    background: var(--chip); position: relative; cursor: pointer; flex: none;
    border: 0; padding: 0; display: block;
  }
  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .toggle::after {
    content: ""; position: absolute; top: 3px; left: 3px;
    width: 16px; height: 16px; border-radius: 50%;
    background: var(--surface); box-shadow: var(--shadow-1);
    transition: left 0.15s;
  }
  .toggle.on { background: var(--accent); }
  .toggle.on::after { left: 21px; }
</style>
