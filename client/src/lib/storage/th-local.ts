/**
 * C+ (CH-2, дизайн 261005-cplus-architecture-consilium, D-3/D-7):
 * клиентский storage-слой — первая ступень localStorage-only (~5 МБ,
 * одно-пользовательские текстовые треды). IndexedDB отложена до реальных
 * файлов day19 (04-MIN-8).
 *
 * Паттерны:
 * - ключи `th.<name>.v<N>` (конвенция trace-store/settings), N — int на
 *   коллекцию; смена схемы → новый N + миграция читает старый ключ;
 * - write-behind try/catch (trace-store), но квота НЕ чистит данные:
 *   треды — единственная копия пользователя (D-7: без облака), при отказе
 *   записи держим в памяти + warn, следующий flush ретраит;
 * - per-record safeParse-drop при загрузке/импорте (persistence.ts):
 *   битая запись падает одна, не хранилище.
 */
import {
  ChatThreadRecordSchema,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  ExportFileSchema,
  type ChatThreadRecord,
  type ExportFile,
} from "@trigger-helper/shared";
import { z } from "zod";

const SAVE_DEBOUNCE_MS = 500; // как trace-store (05-M-5)

interface EnvelopeSchemaShape {
  version: number;
  records: unknown[];
}

export interface LocalCollectionOptions<Record extends { id: string }> {
  name: string;
  version: number;
  /** Структурная сигнатура (safeParse → Record), а не z.ZodType<Record>:
   *  у схем с .default() Input ≠ Output, и вариантность ZodType ломает
   *  вывод типа записей (тот же приём, что api.ts parseWith). */
  schema: { safeParse: (data: unknown) => z.SafeParseReturnType<unknown, Record> };
  /** Кап записей; сверх — выселяется старейшая (порядок вставки, trace-store). */
  maxRecords?: number;
}

export class LocalCollection<Record extends { id: string }> {
  readonly key: string;
  /** Публичное имя коллекции (export/import и реестры). */
  readonly name: string;
  /** Схема записи — per-record safeParse при загрузке/импорте. */
  readonly schema: LocalCollectionOptions<Record>["schema"];
  private records = new Map<string, Record>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(private readonly opts: LocalCollectionOptions<Record>) {
    this.key = `th.${opts.name}.v${opts.version}`;
    this.name = opts.name;
    this.schema = opts.schema;
  }

  /** Ленивая загрузка: per-record safeParse, битая запись падает одна. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.key);
    } catch {
      return; // localStorage недоступен — чистый старт в памяти
    }
    if (!raw) return;
    try {
      const parsed = z
        .object({ version: z.number(), records: z.array(z.unknown()) })
        .parse(JSON.parse(raw)) as EnvelopeSchemaShape;
      if (parsed.version !== this.opts.version) return;
      for (const item of parsed.records) {
        const checked = this.opts.schema.safeParse(item);
        if (checked.success) {
          this.records.set(checked.data.id, checked.data);
        } else {
          console.warn(
            `th-storage: ${this.opts.name}[?] повреждена — запись пропущена`,
          );
        }
      }
    } catch {
      console.warn(
        `th-storage: ${this.key} не читается — старт с пустой коллекции`,
      );
    }
  }

  all(): Record[] {
    this.ensureLoaded();
    return [...this.records.values()];
  }

  get(id: string): Record | undefined {
    this.ensureLoaded();
    return this.records.get(id);
  }

  /** Upsert по id (запись доверяется типу; валидация — на load/import). */
  put(record: Record): void {
    this.ensureLoaded();
    this.records.delete(record.id); // повторная вставка в конец = «свежая»
    this.records.set(record.id, record);
    while (this.opts.maxRecords !== undefined && this.records.size > this.opts.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.scheduleSave();
  }

  delete(id: string): void {
    this.ensureLoaded();
    this.records.delete(id);
    this.scheduleSave();
  }

  /** Замена целиком (импорт: последний выигрывает, 02-F9). */
  replaceAll(records: Record[]): void {
    this.ensureLoaded();
    this.records = new Map(records.map((r) => [r.id, r]));
    this.flushNow();
  }

  /** Write-behind: debounce (trace-store). */
  private scheduleSave(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Принудительная запись сейчас (гасит висящий debounce). */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }

  private save(): void {
    try {
      const envelope = {
        version: this.opts.version,
        records: [...this.records.values()],
      };
      localStorage.setItem(this.key, JSON.stringify(envelope));
    } catch (error) {
      // Квота/недоступность: данные пользователя не выбрасываем (D-7) —
      // держим в памяти, warn, ретрай следующим flush.
      console.warn(`th-storage: не сохранилось ${this.key}`, error);
    }
  }
}

/** Единственная коллекция первой ступени: текстовые треды. */
export const threadsCollection = new LocalCollection({
  name: "threads",
  version: 1,
  schema: ChatThreadRecordSchema,
  maxRecords: 50,
});

/** Живой реестр для export/import (по умолчанию): новые коллекции
 * (например, threadState в chat-state.ts) регистрируются при инициализации. */
const registry: LocalCollection<{ id: string }>[] = [threadsCollection];
export function registerLocalCollection(
  collection: LocalCollection<{ id: string }>,
): void {
  if (!registry.some((c) => c.name === collection.name)) {
    registry.push(collection);
  }
}
export const LOCAL_COLLECTIONS: readonly LocalCollection<{ id: string }>[] =
  registry;

// --- Export / import (D-7) --------------------------------------------------

export type ImportResult =
  | {
      ok: true;
      imported: Record<string, number>;
      dropped: Record<string, number>;
      ignored: string[];
    }
  | { ok: false; error: "invalid_file" };

/** Один zod-валидируемый JSON {format, version, savedAt, collections}. */
export function buildExportFile(
  collections: readonly LocalCollection<{ id: string }>[] = LOCAL_COLLECTIONS,
  now: () => string = () => new Date().toISOString(),
): ExportFile {
  const map: Record<string, unknown[]> = {};
  for (const collection of collections) {
    map[collection.name] = collection.all();
  }
  return ExportFileSchema.parse({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    savedAt: now(),
    collections: map,
  });
}

/** «Последний импорт выигрывает»: коллекции из файла заменяют локальные
 * целиком; коллекций нет в файле — не трогаем. Битая запись падает одна
 * (safeParse-drop). Битой формы файла → { ok: false }, состояние цело. */
export function applyImportFile(
  raw: unknown,
  collections: readonly LocalCollection<{ id: string }>[] = LOCAL_COLLECTIONS,
): ImportResult {
  const parsed = ExportFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_file" };
  const file = parsed.data;
  const imported: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const ignored: string[] = [];
  for (const collection of collections) {
    const rows = file.collections[collection.name];
    if (rows === undefined) continue; // нет в файле — не трогаем
    const good: { id: string }[] = [];
    let bad = 0;
    for (const row of rows) {
      const checked = collection.schema.safeParse(row);
      if (checked.success) good.push(checked.data);
      else bad += 1;
    }
    collection.replaceAll(good);
    imported[collection.name] = good.length;
    if (bad > 0) dropped[collection.name] = bad;
  }
  for (const name of Object.keys(file.collections)) {
    if (!collections.some((c) => c.name === name)) ignored.push(name);
  }
  return { ok: true, imported, dropped, ignored };
}
