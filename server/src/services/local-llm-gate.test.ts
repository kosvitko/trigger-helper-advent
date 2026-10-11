import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalLlmGate,
  getLocalLlmGate,
  initLocalLlmGate,
  resetLocalLlmGateForTests,
} from "./local-llm-gate.js";

describe("local-llm-gate (день 30)", () => {
  afterEach(() => {
    resetLocalLlmGateForTests();
  });

  it("max=1: второй acquire ждёт, пока первый не release", async () => {
    const gate = createLocalLlmGate(1);
    const events: string[] = [];
    let queuedPos: number | null = null;

    const release1 = await gate.acquire();
    events.push("a-in");
    expect(gate.snapshot()).toEqual({ inflight: 1, waiting: 0, max: 1 });

    let release2: (() => void) | undefined;
    const p2 = gate
      .acquire((pos) => {
        queuedPos = pos;
        events.push(`b-queued:${pos}`);
      })
      .then((r) => {
        release2 = r;
        events.push("b-in");
      });

    await Promise.resolve();
    expect(queuedPos).toBe(1);
    expect(gate.snapshot()).toEqual({ inflight: 1, waiting: 1, max: 1 });
    expect(events).toEqual(["a-in", "b-queued:1"]);

    release1();
    await p2;
    expect(events).toEqual(["a-in", "b-queued:1", "b-in"]);
    expect(gate.snapshot()).toEqual({ inflight: 1, waiting: 0, max: 1 });

    release2!();
    expect(gate.snapshot()).toEqual({ inflight: 0, waiting: 0, max: 1 });
  });

  it("три ждущих: при release позиции сдвигаются (2→1, 3→2)", async () => {
    const gate = createLocalLlmGate(1);
    const release1 = await gate.acquire();

    const positions: Record<string, number[]> = { b: [], c: [], d: [] };
    const pB = gate.acquire((pos) => positions.b.push(pos));
    const pC = gate.acquire((pos) => positions.c.push(pos));
    const pD = gate.acquire((pos) => positions.d.push(pos));
    await Promise.resolve();

    expect(positions.b).toEqual([1]);
    expect(positions.c).toEqual([2]);
    expect(positions.d).toEqual([3]);
    expect(gate.snapshot().waiting).toBe(3);

    release1(); // B входит; C→1, D→2
    const releaseB = await pB;
    await Promise.resolve();
    expect(positions.c.at(-1)).toBe(1);
    expect(positions.d.at(-1)).toBe(2);

    releaseB(); // C входит; D→1
    const releaseC = await pC;
    await Promise.resolve();
    expect(positions.d.at(-1)).toBe(1);

    releaseC();
    const releaseD = await pD;
    releaseD();
    expect(gate.snapshot()).toEqual({ inflight: 0, waiting: 0, max: 1 });
  });

  it("max=2: два acquire без очереди", async () => {
    const gate = createLocalLlmGate(2);
    let queued = 0;
    const r1 = await gate.acquire(() => {
      queued += 1;
    });
    const r2 = await gate.acquire(() => {
      queued += 1;
    });
    expect(queued).toBe(0);
    expect(gate.snapshot()).toEqual({ inflight: 2, waiting: 0, max: 2 });
    r1();
    r2();
    expect(gate.snapshot().inflight).toBe(0);
  });

  it("initLocalLlmGate / getLocalLlmGate — один синглтон", () => {
    const a = initLocalLlmGate(1);
    const b = getLocalLlmGate();
    expect(a).toBe(b);
    expect(b.snapshot().max).toBe(1);
  });
});
