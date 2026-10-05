/**
 * Настройки хода (P0: только модель) — ephemeral-overrides.
 * Хранилище — sessionStorage th.overrides.v1 (единый канон, 05-M-3).
 */
import { api, type ModelInfo } from "../api";

const KEY = "th.overrides.v1";

interface Overrides {
  model?: string;
  contextStrategy?: "sliding" | "facts" | "branching";
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
    if (typeof p.contextStrategy === "string" && ["sliding", "facts", "branching"].includes(p.contextStrategy)) {
      o.contextStrategy = p.contextStrategy as Overrides["contextStrategy"];
    }
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

  /** overrides для POST /api/agent/run. */
  runOverrides(): Partial<{ model: string; temperature: number; tools: boolean; historyMode: "tail" | "full"; compressEvery: number; contextStrategy: "facts" | "sliding" | "branching"; ragTool: boolean }> {
    const r: Record<string, unknown> = {};
    if (this.overrides.model) r.model = this.overrides.model;
    if (this.overrides.contextStrategy) r.contextStrategy = this.overrides.contextStrategy;
    if (this.overrides.compressEvery !== undefined && this.overrides.compressEvery !== 0) r.compressEvery = this.overrides.compressEvery;
    if (this.overrides.tools !== undefined) r.tools = this.overrides.tools;
    return r as ReturnType<typeof this.runOverrides>;
  }

  async loadModels(): Promise<void> {
    this.models = (await api.getModels()).models;
  }
}

export const settings = new SettingsStore();
