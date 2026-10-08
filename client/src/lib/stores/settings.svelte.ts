/**
 * Настройки хода (P0: только модель) — ephemeral-overrides.
 * Хранилище — sessionStorage th.overrides.v1 (единый канон, 05-M-3).
 * C+ CH-5b: в ход /api/chat уходят model + tools; compressEvery — триггер
 * сжатия. Стратегии историй умерли с серверными тредами (D-4) — ручки нет.
 * День 26: отсюда же читается local-секция GET /api/models (каталог
 * локальных моделей, D-26-4) — единый источник и для экрана настроек,
 * и для чипа композера; отдельный fetch модели больше не делает никто.
 */
import { api, type ModelInfo } from "../api";
import type { ChatOverrides, LocalModelEntry, LocalModelsSection } from "@trigger-helper/shared";

const KEY = "th.overrides.v1";

interface Overrides {
  model?: string;
  compressEvery?: number;
  tools?: boolean;
}

/** Защищённое чтение: любая ошибка → чистые overrides, молча. */
function readOverrides(): Overrides {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const p = parsed as Record<string, unknown>;
    const o: Overrides = {};
    if (typeof p.model === "string" && p.model) o.model = p.model;
    if (typeof p.compressEvery === "number" && p.compressEvery >= 0) o.compressEvery = p.compressEvery;
    if (typeof p.tools === "boolean") o.tools = p.tools;
    return o;
  } catch {
    return {};
  }
}

class SettingsStore {
  overrides = $state<Overrides>({});
  models = $state<ModelInfo[]>([]);
  /** День 26: local-секция ответа /api/models; null — ещё не загружена
   *  (loadModels зовётся один раз на буте, Shell.svelte). */
  localModels = $state<LocalModelsSection | null>(null);

  /** Локальные записи, доступные на этой машине (D-26-4) — они одни
   *  попадают в дропдаун чипа композера. */
  get availableLocalModels(): LocalModelEntry[] {
    return this.localModels?.entries.filter((e) => e.available) ?? [];
  }

  constructor() {
    this.overrides = readOverrides();
  }

  persist(): void {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(this.overrides));
    } catch {
      /* квота/недоступно — молча */
    }
  }

  setModel(model: string | undefined): void {
    this.overrides.model = model || undefined;
    this.persist();
  }

  /** overrides для POST /api/chat (C+ CH-5b): модель + рельса-тулзы. */
  chatOverrides(): Partial<ChatOverrides> {
    const o: Partial<ChatOverrides> = {};
    if (this.overrides.model) o.model = this.overrides.model;
    if (this.overrides.tools !== undefined) o.tools = this.overrides.tools;
    return o;
  }

  async loadModels(): Promise<void> {
    const res = await api.getModels();
    this.models = res.models;
    this.localModels = res.local;
  }
}

export const settings = new SettingsStore();
