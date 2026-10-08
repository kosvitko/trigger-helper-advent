<script lang="ts">
  // Экран настроек (D-5): секции — только консолидация существующих ручек.
  // Модель / Контекст и память / Поиск по базе / Интерфейс /
  // Данные на устройстве (C+ CH-5b: экспорт/импорт локальных тредов, 02-F9).
  import { settings } from "../stores/settings.svelte";
  import { session } from "../stores/session.svelte";
  import { dialog } from "../stores/dialog.svelte";
  import { api } from "../api";
  import type { LocalModelEntry } from "@trigger-helper/shared";
  import { applyImportFile, buildExportFile } from "../storage/th-local";
  import {
    PROFILES_MAX,
    getProfileState,
    removeProfile,
    setActiveProfile,
    upsertProfile,
    type ProfileStateRecord,
  } from "../profile-state";
  import { uid } from "../uid";

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

  // Загрузка RAG-статистики и серверного дефолта автосжатия. Модели здесь
  // больше НЕ дублируются (день 26): settings.loadModels() тянет /api/models
  // один раз на буте (Shell.svelte) — единый источник для экрана и чипа.
  $effect(() => {
    void (async () => {
      try {
        ragStats = await api.ragStats();
      } catch { /* read-only, сбой не критичен */ }
      try {
        compressDefault = (await api.agentsMeta()).autoCompress?.defaultEvery ?? null;
      } catch { /* дефолт неизвестен — поле с placeholder */ }
    })();
  });

  /* — Локальная модель (день 26, D-26-4): статус рантайма + каталог.
     Поля runtimeOk в контракте нет — клиентская эвристика: рантайм поднят,
     если секция включена и хотя бы одна модель установлена (при лежащем
     рантайме или kill-switch сервер отдаёт installed=false у всех записей).
     Бейджи — из D-26-4: «доступна / мало RAM / не установлена /
     рантайм недоступен»; недоступная запись видна, но не выбирается. — */
  const localRuntimeOk = $derived(
    settings.localModels !== null &&
      settings.localModels.enabled &&
      settings.localModels.entries.some((e) => e.installed),
  );
  const localStatus = $derived(
    settings.localModels === null
      ? "недоступен" // каталог ещё не загружен / сервер не ответил
      : !settings.localModels.enabled
        ? "отключён" // kill-switch LOCAL_LLM_ENABLED
        : localRuntimeOk
          ? "доступен"
          : "недоступен",
  );

  function localBadge(e: LocalModelEntry): string {
    if (!localRuntimeOk) return "рантайм недоступен";
    if (e.available) return "доступна";
    if (!e.fitsRam) return "мало RAM";
    if (!e.installed) return "не установлена";
    return "рантайм недоступен";
  }

  const sections = [
    { id: "model", label: "Модель", icon: "🧠" },
    { id: "local", label: "Локальная модель", icon: "🖥️" },
    { id: "context", label: "Контекст и память", icon: "📚" },
    { id: "search", label: "Поиск по базе", icon: "🔎" },
    { id: "interface", label: "Интерфейс", icon: "🎨" },
    { id: "profile", label: "Профиль", icon: "🧑" },
    { id: "data", label: "Данные (на устройстве)", icon: "💾" },
  ];

  /* — Профиль (день 12, C+ хвосты): глобальная персонализация — один
     активный профиль на пользователя (семантика instance-level router),
     едет в contextTail.profile каждого хода. — */
  let profileState = $state<ProfileStateRecord>(getProfileState());
  let editingProfile = $state<string | null>(null); // id | "new" | null
  let pLabel = $state("");
  let pStyle = $state("");
  let pFormat = $state("");
  let pConstraints = $state("");

  function refreshProfiles(): void {
    profileState = getProfileState();
  }

  function constraintLines(s: string): string[] {
    return s
      .split(/\n+/)
      .map((x) => x.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 5);
  }

  function startNewProfile(): void {
    editingProfile = "new";
    pLabel = "";
    pStyle = "";
    pFormat = "";
    pConstraints = "";
  }

  function startEditProfile(id: string): void {
    const p = profileState.profiles.find((x) => x.id === id);
    if (!p) return;
    editingProfile = id;
    pLabel = p.label;
    pStyle = p.style ?? "";
    pFormat = p.format ?? "";
    pConstraints = (p.constraints ?? []).join("\n");
  }

  function saveProfile(): void {
    if (!pLabel.trim()) return;
    const id = editingProfile === "new" || editingProfile === null ? uid() : editingProfile;
    upsertProfile({
      id,
      label: pLabel.trim().slice(0, 120),
      ...(pStyle.trim() ? { style: pStyle.trim().slice(0, 200) } : {}),
      ...(pFormat.trim() ? { format: pFormat.trim().slice(0, 200) } : {}),
      constraints: constraintLines(pConstraints),
      updatedAt: new Date().toISOString(),
    });
    editingProfile = null;
    refreshProfiles();
  }

  /* — Данные на устройстве (C+ CH-5b, D-7): облака нет — только localStorage;
     «последний импорт выигрывает» (02-F9), экспорт — регулярная привычка. — */
  let dataMessage = $state("");
  let dataError = $state(false);

  function exportData(): void {
    const file = buildExportFile();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trigger-helper-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const counts = Object.entries(file.collections)
      .map(([name, rows]) => `${name}: ${rows.length}`)
      .join(" · ");
    dataMessage = `Экспортировано — ${counts || "пусто"}`;
    dataError = false;
  }

  async function onImportFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const result = applyImportFile(raw);
      if (!result.ok) {
        dataMessage = "файл не распознан";
        dataError = true;
        return;
      }
      const imported = Object.entries(result.imported)
        .map(([name, n]) => `${name}: ${n}`)
        .join(" · ");
      const dropped = Object.entries(result.dropped)
        .map(([name, n]) => `${name}: отброшено ${n}`)
        .join(" · ");
      dataMessage =
        `Импортировано — ${imported || "ничего"}` + (dropped ? ` (${dropped})` : "");
      dataError = false;
      session.reloadThreads();
      void dialog.loadThread().catch(() => undefined);
    } catch {
      dataMessage = "файл не распознан";
      dataError = true;
    } finally {
      input.value = ""; // повторный выбор того же файла снова зовёт onchange
    }
  }
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
            {#each settings.models as m (m.model)}
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
    {:else if openSection === "local"}
      <h2>Локальная модель</h2>
      <p class="sub">Ollama на этом устройстве: ответы без сети и без списания бюджета. В RAG-чате локальная модель отвечает одной ходкой без поиска по базе — в чипе модели есть пометка «без RAG».</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Рантайм Ollama</b><span>Локальный рантайм (127.0.0.1:11434): включён и отвечает</span></div>
          <span class="value">{localStatus}</span>
        </div>
        <div class="row">
          <div class="lbl"><b>Локальная модель ответов</b><span>Та же ручка, что «Модель ответов»; действует на новые ходы</span></div>
          <select bind:value={settings.overrides.model} onchange={() => settings.persist()} aria-label="Локальная модель">
            <option value="">не использовать</option>
            {#each settings.localModels?.entries ?? [] as e (e.id)}
              <option value={e.id} disabled={!e.available}>{e.label} · {localBadge(e)}</option>
            {/each}
          </select>
        </div>
        {#each settings.localModels?.entries ?? [] as e (e.id)}
          <div class="row">
            <div class="lbl">
              <b>{e.label}</b>
              <span>{e.id} · ≈{e.sizeMb} МБ на диске</span>
            </div>
            <span class="value">{localBadge(e)}</span>
          </div>
        {/each}
        {#if settings.localModels === null}
          <div class="row"><div class="lbl"><b>Каталог недоступен</b><span>Сервер не ответил или формат изменился</span></div></div>
        {/if}
      </div>
    {:else if openSection === "context"}
      <h2>Контекст и память</h2>
      <p class="sub">Автосжатие истории (день 09) — триггер на клиенте; стратегии историй умерли вместе с серверными тредами.</p>

      <div class="card">
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
    {:else if openSection === "profile"}
      <h2>Профиль</h2>
      <p class="sub">Персонализация ответов (день 12): активный профиль едет в каждый ход (contextTail.profile) — стиль, формат, ограничения. Без профиля — нейтрально.</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Активный профиль</b><span>Один на пользователя; «без профиля» — нейтральные ответы</span></div>
          <select
            value={profileState.activeProfileId ?? ""}
            onchange={(e) => {
              setActiveProfile((e.currentTarget as HTMLSelectElement).value || null);
              refreshProfiles();
            }}
          >
            <option value="">без профиля</option>
            {#each profileState.profiles as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
          </select>
        </div>
      </div>

      {#each profileState.profiles as p (p.id)}
        <div class="card">
          {#if editingProfile === p.id}
            <div class="prof-edit">
              <label>Название<input type="text" bind:value={pLabel} maxlength="120" /></label>
              <label>Стиль<input type="text" bind:value={pStyle} maxlength="200" placeholder="кратко, по делу" /></label>
              <label>Формат<input type="text" bind:value={pFormat} maxlength="200" placeholder="списками по шагам" /></label>
              <label>Ограничения (по строке, до 5)<textarea bind:value={pConstraints} rows="2"></textarea></label>
              <div class="row">
                <button type="button" class="act" onclick={saveProfile}>готово</button>
                <button type="button" class="link" onclick={() => (editingProfile = null)}>отмена</button>
              </div>
            </div>
          {:else}
            <div class="row">
              <div class="lbl">
                <b>{p.label}{profileState.activeProfileId === p.id ? " · активен" : ""}</b>
                <span>{[p.style, p.format].filter(Boolean).join(" · ") || "без стиля/формата"}{p.constraints.length ? ` · ограничений: ${p.constraints.length}` : ""}</span>
              </div>
              <button type="button" class="act" onclick={() => startEditProfile(p.id)}>изменить</button>
              <button type="button" class="link" onclick={() => { removeProfile(p.id); refreshProfiles(); }}>удалить</button>
            </div>
          {/if}
        </div>
      {/each}

      {#if editingProfile === "new"}
        <div class="card">
          <div class="prof-edit">
            <label>Название<input type="text" bind:value={pLabel} maxlength="120" placeholder="Например: кратко и по шагам" /></label>
            <label>Стиль<input type="text" bind:value={pStyle} maxlength="200" placeholder="кратко, по делу" /></label>
            <label>Формат<input type="text" bind:value={pFormat} maxlength="200" placeholder="списками по шагам" /></label>
            <label>Ограничения (по строке, до 5)<textarea bind:value={pConstraints} rows="2" placeholder="без латиницы"></textarea></label>
            <div class="row">
              <button type="button" class="act" onclick={saveProfile}>создать</button>
              <button type="button" class="link" onclick={() => (editingProfile = null)}>отмена</button>
            </div>
          </div>
        </div>
      {:else if profileState.profiles.length < PROFILES_MAX}
        <button type="button" class="act" onclick={startNewProfile}>+ профиль</button>
      {/if}
    {:else if openSection === "data"}
      <h2>Данные (на устройстве)</h2>
      <p class="sub">Треды и память хранятся только в этом браузере — облака нет. Последний импорт выигрывает; экспортируй регулярно.</p>

      <div class="card">
        <div class="row">
          <div class="lbl"><b>Экспорт</b><span>Скачать все локальные данные одним JSON-файлом</span></div>
          <button type="button" class="act" onclick={exportData}>Скачать JSON</button>
        </div>
        <div class="row">
          <div class="lbl"><b>Импорт</b><span>Заменить локальные данные из файла экспорта (последний импорт выигрывает)</span></div>
          <input type="file" accept="application/json,.json" onchange={(e) => void onImportFile(e)} />
        </div>
        {#if dataMessage}
          <div class="row">
            <span class="data-msg" class:err={dataError}>{dataMessage}</span>
          </div>
        {/if}
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
  select, input[type="number"], input[type="text"] {
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
  .act {
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 10px;
    padding: 8px 14px;
    font: 600 13px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .data-msg {
    color: var(--muted);
    font-size: 12.5px;
  }
  .data-msg.err {
    color: var(--warm);
    font-weight: 600;
  }
  .prof-edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .prof-edit label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--muted);
  }
  .prof-edit input[type="text"],
  .prof-edit textarea {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 12px;
    font: 13px system-ui, sans-serif;
    background: var(--surface);
    color: var(--ink);
    min-width: 0;
    resize: vertical;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: 600 13px/1 system-ui, sans-serif;
  }
</style>
