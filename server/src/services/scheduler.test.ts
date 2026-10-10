/**
 * UNIT — scheduler store / caps / catch-up math (гейт 261009 Pick A, кусок 3).
 * D-2: без PubMed mock — не зовём start()/runJobTick; тик-математика —
 * чистые export'ы countAndAdvanceMissedTicks / isJobExpired.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../config/env.js";
import type { DeepSeekService } from "./deepseek.js";
import type { UsageLedgerService } from "./usage-ledger.js";
import {
  countAndAdvanceMissedTicks,
  createSchedulerService,
  isJobExpired,
} from "./scheduler.js";

const stubDeepSeek = {} as DeepSeekService;
const stubLedger = {
  getTotals: async () => ({ cost_rub_today: 0 }),
  record: async () => ({}),
} as unknown as UsageLedgerService;

function testEnv(schedulerFile: string): Env {
  return {
    DEEPSEEK_API_KEY: "test",
    DEEPSEEK_MODEL: "deepseek-chat",
    PROXYAPI_BASE_URL: "https://openai.api.proxyapi.ru/v1",
    PORT: 3000,
    SCHEDULER_FILE: schedulerFile,
    SCHEDULE_SUMMARY_MIN_SEC: 86_400,
    FREE_DAILY_ASKS: 20,
    MAX_INSTANCES: 8,
    MAX_AGENTS_PER_INSTANCE: 16,
    DEMO_CONTEXT_LIMIT: 0,
    AGENT_COMPRESS_EVERY: 10,
    RATE_LIMIT_MAX: 0,
    RATE_LIMIT_WINDOW_MS: 60_000,
    DAILY_BUDGET_RUB: 0,
    DAILY_BUDGET_EXPENSIVE_RUB: 0,
    BUDGET_DELAY_ALPHA: 2.5,
    BUDGET_DELAY_BETA: 2,
    BUDGET_DELAY_FILL_MS: 20_000,
    BUDGET_DELAY_PACE_MS: 60_000,
    BUDGET_DELAY_MAX_MS: 180_000,
    NODE_ENV: "test",
  } as Env;
}

const tempFiles: string[] = [];

afterEach(async () => {
  for (const f of tempFiles.splice(0)) {
    await fs.rm(f, { force: true }).catch(() => undefined);
    await fs.rm(`${f}.${process.pid}.tmp`, { force: true }).catch(() => undefined);
  }
});

async function tempSchedulerFile(): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `th-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tempFiles.push(file);
  return file;
}

describe("countAndAdvanceMissedTicks — catch-up math", () => {
  it("не трогает future nextRunAt", () => {
    const now = 1_000_000;
    const job = { nextRunAt: now + 5_000, everySec: 30, missed: 0 };
    expect(countAndAdvanceMissedTicks(job, now)).toBe(0);
    expect(job.nextRunAt).toBe(now + 5_000);
    expect(job.missed).toBe(0);
  });

  it("сдвигает overdue за now и считает пропуски", () => {
    const everySec = 30;
    const now = 1_000_000;
    // Просрочено на 2.5 интервала → while даст 3 шага, nextRunAt > now.
    const job = {
      nextRunAt: now - Math.floor(2.5 * everySec * 1000),
      everySec,
      missed: 1,
    };
    const stepped = countAndAdvanceMissedTicks(job, now);
    expect(stepped).toBe(3);
    expect(job.missed).toBe(4);
    expect(job.nextRunAt).toBeGreaterThan(now);
  });
});

describe("isJobExpired", () => {
  it("true после expiresAt", () => {
    const expiresAt = new Date(1_000_000).toISOString();
    expect(isJobExpired({ expiresAt }, 1_000_001)).toBe(true);
    expect(isJobExpired({ expiresAt }, 999_999)).toBe(false);
  });
});

describe("SchedulerService — store / caps (без start)", () => {
  it("scheduleJob → snapshot; 4-й активный → job_cap_reached", async () => {
    const file = await tempSchedulerFile();
    const svc = createSchedulerService({
      env: testEnv(file),
      deepSeek: stubDeepSeek,
      ledger: stubLedger,
    });
    await svc.load();

    await svc.scheduleJob({ query: "neck pain", everySec: 60 });
    await svc.scheduleJob({ query: "shoulder", everySec: 60 });
    await svc.scheduleJob({ query: "back", everySec: 60 });
    expect(svc.snapshot().jobs.filter((j) => j.active)).toHaveLength(3);

    await expect(
      svc.scheduleJob({ query: "fourth", everySec: 60 }),
    ).rejects.toThrow("job_cap_reached");

    const snap = svc.snapshot();
    expect(snap.counters.ticks).toBe(0);
    expect(snap.counters.articles).toBe(0);
  });

  it("cancelJob деактивирует; scheduleJob persist+load сохраняет query", async () => {
    const file = await tempSchedulerFile();
    const svc = createSchedulerService({
      env: testEnv(file),
      deepSeek: stubDeepSeek,
      ledger: stubLedger,
    });
    await svc.load();
    const { jobId } = await svc.scheduleJob({
      query: "massage",
      everySec: 120,
      ttlSec: 3600,
    });
    expect(svc.cancelJob(jobId)).toBe(true);
    expect(svc.snapshot().jobs.find((j) => j.id === jobId)?.active).toBe(false);
    // scheduleJob ждёт persist — дописывает store (вкл. cancelled) на диск.
    await svc.scheduleJob({ query: "other", everySec: 60 });

    const svc2 = createSchedulerService({
      env: testEnv(file),
      deepSeek: stubDeepSeek,
      ledger: stubLedger,
    });
    await svc2.load();
    const reloaded = svc2.snapshot().jobs.find((j) => j.id === jobId);
    expect(reloaded?.active).toBe(false);
    expect(reloaded?.query).toBe("massage");
    expect(svc2.snapshot().jobs.filter((j) => j.active)).toHaveLength(1);
  });
});
