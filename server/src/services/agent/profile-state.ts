import type {
  ProfileState,
  UserProfile,
  UserProfileCreate,
  UserProfilePatch,
} from "@trigger-helper/shared";

export type ProfileStateOptions = {
  onChange?: () => void;
};

function emptyState(): ProfileState {
  return { profiles: [], activeProfileId: null };
}

/** Day12 seed (D-2): two structural-contrast profiles; active stays null (HR-5). */
function seedState(): ProfileState {
  const now = new Date().toISOString();
  return {
    activeProfileId: null,
    profiles: [
      {
        id: crypto.randomUUID(),
        label: "Кратко и по делу",
        style: "Обращайся на «ты». Нейтральный тон, без вступлений и эмодзи.",
        format: "Только маркированные списки, максимум 5 пунктов.",
        constraints: [],
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        label: "Тепло и развёрнуто",
        style: "Тёплый поддерживающий тон, короткое вступление-эмпатия в начале.",
        format: "2–3 связных абзаца текстом, без списков.",
        constraints: [],
        updatedAt: now,
      },
    ],
  };
}

/**
 * Day12: instance-level personalization — user profiles + manual router
 * (activeProfileId). Mirrors MemoryStateStore; key = instanceId only.
 * get()/getActiveProfile() are pure (no onChange, no disk writes from reads);
 * seeding happens only via explicit ensureSeed() call from the GET route.
 */
export class ProfileStateStore {
  private readonly byInstance = new Map<string, ProfileState>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: ProfileStateOptions = {}) {
    this.onChange = opts.onChange;
  }

  get(instanceId: string): ProfileState {
    const state = this.byInstance.get(instanceId) ?? emptyState();
    return {
      profiles: state.profiles.map((p) => ({ ...p, constraints: [...p.constraints] })),
      activeProfileId: state.activeProfileId,
    };
  }

  getActiveProfile(instanceId: string): UserProfile | null {
    const state = this.byInstance.get(instanceId);
    if (!state?.activeProfileId) return null;
    const found = state.profiles.find((p) => p.id === state.activeProfileId);
    return found ? { ...found, constraints: [...found.constraints] } : null;
  }

  /** Seed-once for a fresh instance record; keeps an emptied record empty. */
  ensureSeed(instanceId: string): ProfileState {
    if (!this.byInstance.has(instanceId)) {
      this.byInstance.set(instanceId, seedState());
      this.onChange?.();
    }
    return this.get(instanceId);
  }

  create(instanceId: string, data: UserProfileCreate): UserProfile {
    const prev = this.byInstance.get(instanceId) ?? emptyState();
    const profile: UserProfile = {
      id: crypto.randomUUID(),
      label: data.label,
      ...(data.style !== undefined ? { style: data.style } : {}),
      ...(data.format !== undefined ? { format: data.format } : {}),
      constraints: [...data.constraints],
      updatedAt: new Date().toISOString(),
    };
    this.byInstance.set(instanceId, {
      profiles: [...prev.profiles, profile],
      activeProfileId: prev.activeProfileId,
    });
    this.onChange?.();
    return { ...profile, constraints: [...profile.constraints] };
  }

  /** PATCH semantics: absent field = keep; explicit empty = clear
   *  (constraints: undefined keeps, [] clears — pass 04 Fix-4). */
  update(
    instanceId: string,
    profileId: string,
    patch: UserProfilePatch,
  ): UserProfile | null {
    const state = this.byInstance.get(instanceId);
    if (!state) return null;
    const idx = state.profiles.findIndex((p) => p.id === profileId);
    if (idx < 0) return null;
    const prev = state.profiles[idx]!;
    const next: UserProfile = {
      ...prev,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.style !== undefined ? { style: patch.style } : {}),
      ...(patch.format !== undefined ? { format: patch.format } : {}),
      ...(patch.constraints !== undefined
        ? { constraints: [...patch.constraints] }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const profiles = [...state.profiles];
    profiles[idx] = next;
    this.byInstance.set(instanceId, { profiles, activeProfileId: state.activeProfileId });
    this.onChange?.();
    return { ...next, constraints: [...next.constraints] };
  }

  remove(
    instanceId: string,
    profileId: string,
  ): "ok" | "not_found" | "active" {
    const state = this.byInstance.get(instanceId);
    if (!state) return "not_found";
    if (!state.profiles.some((p) => p.id === profileId)) return "not_found";
    if (state.activeProfileId === profileId) return "active";
    this.byInstance.set(instanceId, {
      profiles: state.profiles.filter((p) => p.id !== profileId),
      activeProfileId: state.activeProfileId,
    });
    this.onChange?.();
    return "ok";
  }

  /** Router: profileId=null = explicit deactivation (always ok). */
  activate(instanceId: string, profileId: string | null): ProfileState | null {
    const state = this.byInstance.get(instanceId);
    if (!state) return null;
    if (profileId !== null && !state.profiles.some((p) => p.id === profileId)) {
      return null;
    }
    this.byInstance.set(instanceId, {
      profiles: state.profiles,
      activeProfileId: profileId,
    });
    this.onChange?.();
    return this.get(instanceId);
  }

  clearInstance(instanceId: string): void {
    this.byInstance.delete(instanceId);
    this.onChange?.();
  }

  snapshot(): Record<string, ProfileState> {
    return Object.fromEntries(
      [...this.byInstance.entries()].map(([k, v]) => [k, this.get(k)]),
    );
  }

  load(map: Record<string, ProfileState> | undefined): void {
    this.byInstance.clear();
    for (const [k, v] of Object.entries(map ?? {})) {
      this.byInstance.set(k, {
        profiles: Array.isArray(v.profiles)
          ? v.profiles.map((p) => ({ ...p, constraints: [...p.constraints] }))
          : [],
        activeProfileId: v.activeProfileId ?? null,
      });
    }
  }
}

export function createProfileStateStore(
  opts?: ProfileStateOptions,
): ProfileStateStore {
  return new ProfileStateStore(opts);
}
