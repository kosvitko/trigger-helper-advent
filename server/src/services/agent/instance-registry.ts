import type {
  AgentInstance,
  AgentPreset,
  AgentPresetId,
  Instance,
} from "@trigger-helper/shared";
import { randomUUID } from "node:crypto";
import { getPreset } from "./presets.js";

export type InstanceRegistryCaps = {
  maxInstances: number;
  maxAgentsPerInstance: number;
};

export class InstanceRegistryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "InstanceRegistryError";
  }
}

function snapshotPreset(
  preset: AgentPreset,
  label: string,
): AgentInstance {
  return {
    id: randomUUID(),
    presetId: preset.id,
    label,
    role: preset.role,
    instructions: preset.instructions,
    layers: { ...preset.layers },
    inputPolicy: { ...preset.inputPolicy },
    outputPolicy: { ...preset.outputPolicy },
    defaultModel: preset.defaultModel,
    defaultTemperature: preset.defaultTemperature,
  };
}

export type RegistrySnapshot = {
  instanceSeq: number;
  agentSeqByInstance: Record<string, number>;
  instances: Instance[];
};

export class InstanceRegistry {
  private readonly instances = new Map<string, Instance>();
  private instanceSeq = 0;
  private readonly agentSeqByInstance = new Map<string, number>();

  constructor(
    private readonly caps: InstanceRegistryCaps,
    private readonly onChange?: () => void,
  ) {}

  list(): Instance[] {
    return [...this.instances.values()];
  }

  get(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  getAgent(
    instanceId: string,
    agentId: string,
  ): { instance: Instance; agent: AgentInstance } | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;
    const agent = instance.agents.find((a) => a.id === agentId);
    if (!agent) return undefined;
    return { instance, agent };
  }

  create(opts: {
    label?: string;
    seedPresetIds?: AgentPresetId[];
  } = {}): Instance {
    if (this.instances.size >= this.caps.maxInstances) {
      throw new InstanceRegistryError(
        `Лимит инстансов: ${this.caps.maxInstances}`,
        429,
      );
    }

    this.instanceSeq += 1;
    const seedIds = opts.seedPresetIds?.length
      ? opts.seedPresetIds
      : (["care"] as AgentPresetId[]);

    const id = randomUUID();
    this.agentSeqByInstance.set(id, 0);

    const agents: AgentInstance[] = [];
    for (const presetId of seedIds) {
      if (agents.length >= this.caps.maxAgentsPerInstance) break;
      agents.push(this.makeAgent(id, presetId));
    }

    const instance: Instance = {
      id,
      label: opts.label ?? `Demo ${this.instanceSeq}`,
      agents,
      createdAt: new Date().toISOString(),
    };
    this.instances.set(id, instance);
    this.onChange?.();
    return instance;
  }

  addAgent(
    instanceId: string,
    presetId: AgentPresetId,
    label?: string,
  ): AgentInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new InstanceRegistryError("Инстанс не найден", 404);
    }
    if (instance.agents.length >= this.caps.maxAgentsPerInstance) {
      throw new InstanceRegistryError(
        `Лимит агентов в инстансе: ${this.caps.maxAgentsPerInstance}`,
        429,
      );
    }
    const agent = this.makeAgent(instanceId, presetId, label);
    instance.agents.push(agent);
    this.onChange?.();
    return agent;
  }

  /**
   * Spawn evidence without N LLM calls.
   * Returns created count + sample ids (≤3).
   */
  spawn(
    kind: "agents" | "instances",
    count: number,
    opts: { instanceId?: string; presetId?: AgentPresetId } = {},
  ): { created: number; sample: Array<{ id: string; label: string }> } {
    const sample: Array<{ id: string; label: string }> = [];
    let created = 0;

    if (kind === "instances") {
      for (let i = 0; i < count; i++) {
        if (this.instances.size >= this.caps.maxInstances) break;
        const inst = this.create({
          label: `Spawn ${this.instanceSeq + 1}`,
          seedPresetIds: [opts.presetId ?? "care"],
        });
        created += 1;
        if (sample.length < 3) {
          sample.push({ id: inst.id, label: inst.label });
        }
      }
      return { created, sample };
    }

    const instanceId = opts.instanceId;
    if (!instanceId) {
      throw new InstanceRegistryError("instanceId нужен для spawn agents");
    }
    if (!this.instances.get(instanceId)) {
      throw new InstanceRegistryError("Инстанс не найден", 404);
    }
    const presetId = opts.presetId ?? "care";
    for (let i = 0; i < count; i++) {
      const instance = this.instances.get(instanceId)!;
      if (instance.agents.length >= this.caps.maxAgentsPerInstance) break;
      const agent = this.addAgent(instanceId, presetId);
      created += 1;
      if (sample.length < 3) {
        sample.push({ id: agent.id, label: agent.label });
      }
    }
    return { created, sample };
  }

  private makeAgent(
    instanceId: string,
    presetId: AgentPresetId,
    labelOverride?: string,
  ): AgentInstance {
    const preset = getPreset(presetId);
    if (!preset) {
      throw new InstanceRegistryError(`Неизвестный пресет: ${presetId}`);
    }
    const seq = this.nextAgentSeq(instanceId);
    const label = labelOverride ?? `${preset.label} #${seq}`;
    return snapshotPreset(preset, label);
  }

  removeAgent(instanceId: string, agentId: string): AgentInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new InstanceRegistryError("Инстанс не найден", 404);
    }
    if (instance.agents.length <= 1) {
      throw new InstanceRegistryError(
        "Нельзя закрыть последнего агента в инстансе",
        400,
      );
    }
    const idx = instance.agents.findIndex((a) => a.id === agentId);
    if (idx < 0) {
      throw new InstanceRegistryError("Агент не найден", 404);
    }
    const [agent] = instance.agents.splice(idx, 1);
    this.onChange?.();
    return agent;
  }

  removeInstance(instanceId: string): Instance {
    if (this.instances.size <= 1) {
      throw new InstanceRegistryError("Нельзя закрыть последний инстанс", 400);
    }
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new InstanceRegistryError("Инстанс не найден", 404);
    }
    this.instances.delete(instanceId);
    this.agentSeqByInstance.delete(instanceId);
    this.onChange?.();
    return instance;
  }

  /** Undo close: put agent back (same id). */
  restoreAgent(
    instanceId: string,
    agent: AgentInstance,
    index?: number,
  ): AgentInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new InstanceRegistryError("Инстанс не найден", 404);
    }
    if (instance.agents.some((a) => a.id === agent.id)) {
      throw new InstanceRegistryError("Агент уже есть", 409);
    }
    if (instance.agents.length >= this.caps.maxAgentsPerInstance) {
      throw new InstanceRegistryError(
        `Лимит агентов в инстансе: ${this.caps.maxAgentsPerInstance}`,
        429,
      );
    }
    const at =
      index !== undefined && index >= 0 && index <= instance.agents.length
        ? index
        : instance.agents.length;
    instance.agents.splice(at, 0, agent);
    this.onChange?.();
    return agent;
  }

  /** Undo close: put instance back (same id). */
  restoreInstance(instance: Instance): Instance {
    if (this.instances.has(instance.id)) {
      throw new InstanceRegistryError("Инстанс уже есть", 409);
    }
    if (this.instances.size >= this.caps.maxInstances) {
      throw new InstanceRegistryError(
        `Лимит инстансов: ${this.caps.maxInstances}`,
        429,
      );
    }
    this.instances.set(instance.id, instance);
    if (!this.agentSeqByInstance.has(instance.id)) {
      this.agentSeqByInstance.set(instance.id, instance.agents.length);
    }
    this.onChange?.();
    return instance;
  }

  /** Day07: full state for the snapshot file. */
  snapshotState(): RegistrySnapshot {
    return {
      instanceSeq: this.instanceSeq,
      agentSeqByInstance: Object.fromEntries(this.agentSeqByInstance),
      instances: this.list(),
    };
  }

  /** Day07: restore from the state file (trusted local file; bypasses caps). */
  loadState(state: Partial<RegistrySnapshot>): void {
    this.instanceSeq = state.instanceSeq ?? this.instanceSeq;
    for (const [id, seq] of Object.entries(state.agentSeqByInstance ?? {})) {
      this.agentSeqByInstance.set(id, seq);
    }
    for (const instance of state.instances ?? []) {
      if (
        !instance ||
        typeof instance.id !== "string" ||
        !Array.isArray(instance.agents)
      ) {
        continue;
      }
      this.instances.set(instance.id, instance);
      if (!this.agentSeqByInstance.has(instance.id)) {
        this.agentSeqByInstance.set(instance.id, instance.agents.length);
      }
    }
  }

  private nextAgentSeq(instanceId: string): number {
    const prev = this.agentSeqByInstance.get(instanceId) ?? 0;
    const next = prev + 1;
    this.agentSeqByInstance.set(instanceId, next);
    return next;
  }
}

export function createInstanceRegistry(
  caps: InstanceRegistryCaps,
  opts: { seed?: boolean; onChange?: () => void } = {},
): InstanceRegistry {
  const registry = new InstanceRegistry(caps, opts.onChange);
  // Seed for step-1 run: one instance with Care (fresh state only —
  // with a persisted snapshot the seed would duplicate day07 state)
  if (opts.seed !== false) {
    registry.create({ label: "Demo", seedPresetIds: ["care"] });
  }
  return registry;
}
