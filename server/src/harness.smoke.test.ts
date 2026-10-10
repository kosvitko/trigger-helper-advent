/**
 * Smoke харнесса: vitest под server/src поднимается и резолвит модуль.
 * Контракты chat / scheduler / RAG — отдельные *.test.ts (куски 2–4).
 */
import { describe, expect, it } from "vitest";
import { costRubFromUsage } from "./services/pricing.js";

describe("server vitest harness", () => {
  it("runs under node and imports a server module", () => {
    expect(typeof costRubFromUsage).toBe("function");
    expect(costRubFromUsage({ estimated_cost_usd: 0, estimated_cost_rub: 0 })).toBe(
      0,
    );
  });
});
