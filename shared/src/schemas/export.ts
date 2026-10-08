import { z } from "zod";

/**
 * C+ (CH-2, дизайн 261005-cplus-architecture-consilium, D-7): export-файл —
 * перенос локального состояния устройство↔устройство. Формат — один
 * версионируемый JSON; импорт — «последний импорт выигрывает» (02-F9):
 * коллекции заменяются целиком после per-record safeParse (битая запись
 * падает одна, не файл). Потеря устройства = потеря данных (без облака) —
 * напоминалка об экспорте — забота UI (CH-5).
 */

export const EXPORT_FORMAT = "trigger-helper.export";
export const EXPORT_VERSION = 1;

/** collections: имя коллекции → записи (запись валидируется схемой своей
 * коллекции на импорте; сам файл знает только форму). */
export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  /** int на коллекцию живёт в ключе localStorage (th.<name>.v<N>);
   * version файла — версия формата целиком. */
  version: z.number().int().positive(),
  savedAt: z.string().min(1),
  collections: z.record(z.string(), z.array(z.unknown())),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;
