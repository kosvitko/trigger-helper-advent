import { z } from "zod";

/**
 * День 26: контракт GET /api/models. Раньше ответ был ad-hoc-объектом
 * routes/models.ts ({ models: [{tier,label,model,via}] }) — фиксируем его
 * схемой и дополняем аддитивно local-секцией каталога локальных моделей
 * (D-26-4). Обратная совместимость: поля добавляются, не переименовываются
 * (monorepo деплоится одним коммитом).
 */

/** Облачные записи (справочник day05, DemoModelInfo на сервере). */
export const CloudModelInfoSchema = z.object({
  tier: z.enum(["weak", "mid", "strong"]),
  label: z.string(),
  model: z.string(),
  via: z.enum(["proxyapi", "deepseek"]),
});
export type CloudModelInfo = z.infer<typeof CloudModelInfoSchema>;

/** Запись каталога локальных моделей (Ollama, D-26-4): «видна с бейджем,
 * выбрать нельзя» — reason недоступности клиент выводит из полей. */
export const LocalModelEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  sizeMb: z.number().nonnegative(),
  installed: z.boolean(),
  fitsRam: z.boolean(),
  available: z.boolean(),
});
export type LocalModelEntry = z.infer<typeof LocalModelEntrySchema>;

export const LocalModelsSectionSchema = z.object({
  runtime: z.literal("ollama"),
  enabled: z.boolean(),
  entries: z.array(LocalModelEntrySchema),
});
export type LocalModelsSection = z.infer<typeof LocalModelsSectionSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(CloudModelInfoSchema),
  local: LocalModelsSectionSchema,
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
