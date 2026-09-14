import type {
  AgentContextStrategy,
  FactsMap,
} from "@trigger-helper/shared";

export type BranchMeta = {
  forked: boolean;
  activeBranchId: "a" | "b" | null;
  checkpointCount: number;
};

export type Day10SnapshotSlice = {
  facts: Record<string, FactsMap>;
  branching: Record<string, BranchMeta>;
  strategyByAgent: Record<string, AgentContextStrategy>;
};

function metaKey(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

/** Thread keys for base agent + both branches (M-2 purge). */
export function branchKeys(agentId: string): [string, string, string] {
  return [agentId, `${agentId}#a`, `${agentId}#b`];
}

export type Day10StateOptions = {
  onChange?: () => void;
};

/**
 * Day10 in-memory maps: sticky facts, branching meta, last Lab strategy.
 * Snapshot fields ride alongside threads in agent-state.json.
 */
export class Day10StateStore {
  private readonly facts = new Map<string, FactsMap>();
  private readonly branching = new Map<string, BranchMeta>();
  private readonly strategyByAgent = new Map<string, AgentContextStrategy>();
  private readonly onChange: (() => void) | undefined;

  constructor(opts: Day10StateOptions = {}) {
    this.onChange = opts.onChange;
  }

  getFacts(instanceId: string, agentId: string): FactsMap {
    return { ...(this.facts.get(metaKey(instanceId, agentId)) ?? {}) };
  }

  setFacts(instanceId: string, agentId: string, facts: FactsMap): void {
    this.facts.set(metaKey(instanceId, agentId), { ...facts });
    this.onChange?.();
  }

  getBranching(instanceId: string, agentId: string): BranchMeta | undefined {
    const meta = this.branching.get(metaKey(instanceId, agentId));
    return meta ? { ...meta } : undefined;
  }

  setBranching(instanceId: string, agentId: string, meta: BranchMeta): void {
    this.branching.set(metaKey(instanceId, agentId), { ...meta });
    this.onChange?.();
  }

  getStrategy(
    instanceId: string,
    agentId: string,
  ): AgentContextStrategy | undefined {
    return this.strategyByAgent.get(metaKey(instanceId, agentId));
  }

  setStrategy(
    instanceId: string,
    agentId: string,
    strategy: AgentContextStrategy,
  ): void {
    this.strategyByAgent.set(metaKey(instanceId, agentId), strategy);
    this.onChange?.();
  }

  /** Clear base-key meta (facts / branching / strategy). Thread keys cleared separately. */
  clearAgent(instanceId: string, agentId: string): void {
    const k = metaKey(instanceId, agentId);
    this.facts.delete(k);
    this.branching.delete(k);
    this.strategyByAgent.delete(k);
    this.onChange?.();
  }

  /**
   * Active thread key for run/list/compress.
   * Branching + forked + active → `agentId#a|b`; else base agentId.
   */
  resolveThreadAgentId(
    instanceId: string,
    agentId: string,
    strategy?: AgentContextStrategy | null,
  ): string {
    if (strategy === "branching") {
      const meta = this.branching.get(metaKey(instanceId, agentId));
      if (meta?.forked && meta.activeBranchId) {
        return `${agentId}#${meta.activeBranchId}`;
      }
    }
    return agentId;
  }

  snapshot(): Day10SnapshotSlice {
    return {
      facts: Object.fromEntries(
        [...this.facts.entries()].map(([k, v]) => [k, { ...v }]),
      ),
      branching: Object.fromEntries(
        [...this.branching.entries()].map(([k, v]) => [k, { ...v }]),
      ),
      strategyByAgent: Object.fromEntries(this.strategyByAgent.entries()),
    };
  }

  load(slice: Partial<Day10SnapshotSlice>): void {
    this.facts.clear();
    this.branching.clear();
    this.strategyByAgent.clear();
    for (const [k, v] of Object.entries(slice.facts ?? {})) {
      this.facts.set(k, { ...v });
    }
    for (const [k, v] of Object.entries(slice.branching ?? {})) {
      this.branching.set(k, { ...v });
    }
    for (const [k, v] of Object.entries(slice.strategyByAgent ?? {})) {
      this.strategyByAgent.set(k, v);
    }
  }
}

export function createDay10StateStore(
  opts: Day10StateOptions = {},
): Day10StateStore {
  return new Day10StateStore(opts);
}
