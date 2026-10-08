/**
 * C+ хвосты (день 12 → клиент, D-4): профили персонализации — глобальная
 * коллекция th.profiles.v1, одна запись {id:"global", profiles, activeProfileId}
 * (наследование семантики «instance-level router»: один активный профиль).
 * Композер contextTail берёт активный профиль; export/import подхватывает
 * коллекцию реестром автоматически (CH-2).
 */
import { z } from "zod";
import { UserProfileSchema, type UserProfile } from "@trigger-helper/shared";
import { LocalCollection, registerLocalCollection } from "./storage/th-local";

export const PROFILES_MAX = 8;

const ProfileStateRecordSchema = z.object({
  id: z.literal("global"),
  profiles: z.array(UserProfileSchema).max(PROFILES_MAX).default([]),
  activeProfileId: z.string().min(1).nullable().default(null),
});
export type ProfileStateRecord = z.infer<typeof ProfileStateRecordSchema>;

/** Глобальное состояние профилей; ключ — единственная запись "global". */
export const profilesCollection = new LocalCollection({
  name: "profiles",
  version: 1,
  schema: ProfileStateRecordSchema,
  maxRecords: 1,
});
registerLocalCollection(profilesCollection); // export/import видит всё

const EMPTY: ProfileStateRecord = {
  id: "global",
  profiles: [],
  activeProfileId: null,
};

export function getProfileState(): ProfileStateRecord {
  return profilesCollection.get("global") ?? EMPTY;
}

/** Активный профиль для contextTail (null = блок profile не шлётся). */
export function getActiveProfile(): UserProfile | null {
  const s = getProfileState();
  if (!s.activeProfileId) return null;
  return s.profiles.find((p) => p.id === s.activeProfileId) ?? null;
}

function putState(next: Omit<ProfileStateRecord, "id">): ProfileStateRecord {
  const record = { ...next, id: "global" as const };
  profilesCollection.put(record);
  return record;
}

/** Добавить/обновить профиль (id — за вызывающим: uid()). */
export function upsertProfile(profile: UserProfile): ProfileStateRecord {
  const s = getProfileState();
  const exists = s.profiles.some((p) => p.id === profile.id);
  const profiles = exists
    ? s.profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...s.profiles, profile].slice(0, PROFILES_MAX);
  return putState({ ...s, profiles });
}

export function removeProfile(id: string): ProfileStateRecord {
  const s = getProfileState();
  return putState({
    profiles: s.profiles.filter((p) => p.id !== id),
    activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
  });
}

/** Активный профиль (null — без персонализации). */
export function setActiveProfile(id: string | null): ProfileStateRecord {
  const s = getProfileState();
  if (id !== null && !s.profiles.some((p) => p.id === id)) return s;
  return putState({ ...s, activeProfileId: id });
}
