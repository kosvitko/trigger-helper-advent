/**
 * UNIT — клиентский storage-слой C+ (CH-2, D-3/D-7): localStorage-коллекции
 * th.<name>.v<N> (per-record safeParse-drop, write-behind debounce, квота
 * НЕ чистит данные пользователя), export {format, version, savedAt,
 * collections}, импорт «последний выигрывает».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_FORMAT,
  ExportFileSchema,
  ChatThreadRecordSchema,
  type ChatThreadRecord,
} from "@trigger-helper/shared";
import {
  applyImportFile,
  buildExportFile,
  LocalCollection,
} from "./th-local";

function thread(id: string, over: Partial<ChatThreadRecord> = {}): ChatThreadRecord {
  return {
    id,
    preset: "care",
    title: `Тред ${id}`,
    createdAt: "2026-10-05T10:00:00Z",
    updatedAt: "2026-10-05T10:00:00Z",
    summaries: [],
    dialogue: [
      { role: "user", content: "болит шея" },
      { role: "assistant", content: "проверь мышцу сбоку" },
    ],
    ...over,
  };
}

function realCollection(maxRecords?: number): LocalCollection<ChatThreadRecord> {
  return new LocalCollection({
    name: "threads",
    version: 1,
    schema: ChatThreadRecordSchema,
    maxRecords,
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("LocalCollection — load/save", () => {
  it("round-trip: put → flush → новый экземпляр читает то же", () => {
    const c = realCollection();
    c.put(thread("a"));
    c.put(thread("b"));
    c.flushNow();
    const reloaded = realCollection();
    expect(reloaded.all().map((t) => t.id)).toEqual(["a", "b"]);
    expect(reloaded.get("a")?.dialogue).toHaveLength(2);
  });

  it("битая запись падает одна (safeParse-drop + warn), не хранилище", () => {
    const good = thread("good");
    const envelope = {
      version: 1,
      records: [good, { id: "bad", preset: "no-such-preset" }],
    };
    localStorage.setItem("th.threads.v1", JSON.stringify(envelope));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = realCollection();
    expect(c.all().map((t) => t.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("версия в конверте ≠ версии коллекции — игнор (чистый старт)", () => {
    localStorage.setItem(
      "th.threads.v1",
      JSON.stringify({ version: 2, records: [thread("x")] }),
    );
    expect(realCollection().all()).toEqual([]);
  });

  it("maxRecords: сверх капа выселяется старейшая", () => {
    const c = realCollection(3);
    for (const id of ["a", "b", "c", "d"]) c.put(thread(id));
    expect(c.all().map((t) => t.id)).toEqual(["b", "c", "d"]);
  });

  it("upsert существующего id не размножает запись", () => {
    const c = realCollection();
    c.put(thread("a", { title: "было" }));
    c.put(thread("a", { title: "стало" }));
    expect(c.all()).toHaveLength(1);
    expect(c.get("a")?.title).toBe("стало");
  });

  it("write-behind: запись уходит через debounce 500 мс", () => {
    vi.useFakeTimers();
    const c = realCollection();
    c.put(thread("a"));
    expect(localStorage.getItem("th.threads.v1")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem("th.threads.v1")).not.toBeNull();
    vi.useRealTimers();
  });

  it("квота: setItem падает — warn, данные в памяти целы, ретрай пишет", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("QuotaExceededError");
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = realCollection();
    c.put(thread("a"));
    c.flushNow(); // первый setItem — бросает
    expect(c.all()).toHaveLength(1); // в памяти жива
    c.flushNow(); // ретрай — реальный setItem
    expect(realCollection().all().map((t) => t.id)).toEqual(["a"]);
    // и никакой removeItem-чистки данных (D-7): ключ не стёрт при отказе
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe("export / import (D-7)", () => {
  it("buildExportFile: форма валидна, коллекции на месте", () => {
    const c = realCollection();
    c.put(thread("a"));
    c.put(thread("b"));
    const file = buildExportFile([c], () => "2026-10-05T12:00:00Z");
    expect(
      ExportFileSchema.safeParse(file).success,
    ).toBe(true);
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(file.savedAt).toBe("2026-10-05T12:00:00Z");
    expect(file.collections.threads).toHaveLength(2);
  });

  it("импорт «последний выигрывает»: локальные заменяются целиком", () => {
    const local = realCollection();
    local.put(thread("old-1"));
    local.put(thread("old-2"));
    const result = applyImportFile(
      {
        format: EXPORT_FORMAT,
        version: 1,
        savedAt: "2026-10-05T12:00:00Z",
        collections: {
          threads: [thread("new-1"), thread("new-2"), thread("new-3")],
        },
      },
      [local],
    );
    expect(result).toMatchObject({ ok: true, imported: { threads: 3 } });
    expect(local.all().map((t) => t.id)).toEqual(["new-1", "new-2", "new-3"]);
  });

  it("битая запись файла падает одна; битый файл не трогает состояние", () => {
    const local = realCollection();
    local.put(thread("keep"));
    const corrupt = { format: EXPORT_FORMAT, version: 1, savedAt: "x", collections: { threads: [thread("ok"), { id: "bad", preset: 42 }] } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyImportFile(corrupt, [local]);
    expect(result).toMatchObject({ ok: true, imported: { threads: 1 }, dropped: { threads: 1 } });
    expect(local.all().map((t) => t.id)).toEqual(["ok"]);
    const badFile = applyImportFile({ format: "other", version: 1, savedAt: "x", collections: {} }, [local]);
    expect(badFile).toEqual({ ok: false, error: "invalid_file" });
    expect(local.all().map((t) => t.id)).toEqual(["ok"]); // состояние цело
    warn.mockRestore();
  });

  it("неизвестные коллекции файла игнорируются поимённо", () => {
    const local = realCollection();
    const result = applyImportFile(
      {
        format: EXPORT_FORMAT,
        version: 1,
        savedAt: "x",
        collections: { day19Artifacts: ["foo"] },
      },
      [local],
    );
    expect(result).toMatchObject({ ok: true, ignored: ["day19Artifacts"] });
  });
});
