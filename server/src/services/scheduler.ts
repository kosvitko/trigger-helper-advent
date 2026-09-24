import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { DeepSeekService } from "./deepseek.js";
import type { UsageLedgerService } from "./usage-ledger.js";
import type { ThreadStore } from "./agent/threads.js";
import { costRubFromUsage } from "./pricing.js";
// Day19: PubMed client moved to its own module (shared with pipeline tools).
import { efetchAbstract, esearch, esummary } from "./pubmed.js";

/**
 * Day18: background scheduler — periodic PubMed collection jobs (₽0 ticks)
 * plus proactive LLM digests (debounced, budget-guarded, retro mode).
 * Design: docs/reviews/260924-day18-design.md §4; canon gate §7 (Pick B″).
 *
 * Store is the single seam (jobs/seenPmids/articles/summaries/counters);
 * writers (ticks / MCP tools / summary pipeline) mutate synchronously and
 * persist through a serialized promise chain with atomic tmp+rename writes
 * (same pattern as usage-ledger).
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Deep-archive query when no job ever defined one (design §4.1, pass 04 п.6). */
const DEFAULT_QUERY = "massage therapy";
const ACTIVE_JOBS_MAX = 3;
const JOBS_MAX = 30;
const SEEN_MAX = 1000;
const ARTICLES_MAX = 200;
const SUMMARIES_MAX = 50;
const FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ESEARCH_WINDOW_DAYS = 30;
const SUMMARY_BATCH_MAX = 3;
const ABSTRACT_CAP = 4000;
/** Design D-4: background summaries use deepseek-chat only (known price). */
const SUMMARY_MODEL = "deepseek-chat";
const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_MAX_TOKENS = 500;
/** Background ₽ gate keeps a margin below the user-facing budget ceiling. */
const BUDGET_MARGIN = 0.95;

const JobSchema = z.object({
  id: z.string(),
  query: z.string(),
  everySec: z.number().int().gte(30),
  ttlSec: z.number().int().positive(),
  createdAt: z.string(),
  expiresAt: z.string(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  missed: z.number().int().nonnegative(),
  active: z.boolean(),
});

const ArticleSchema = z.object({
  pmid: z.string(),
  title: z.string(),
  journal: z.string(),
  pubdate: z.string(),
  epubdate: z.string(),
  authors: z.array(z.string()).max(3),
  query: z.string(),
  jobId: z.string().nullable(),
  fetchedAt: z.string(),
  state: z.enum(["pending", "digested"]),
  /** Informational only — nothing follows this link (pass 05 п.6). */
  summaryId: z.string().optional(),
});

const SummarySchema = z.object({
  id: z.string(),
  at: z.string(),
  mode: z.enum(["fresh", "archive"]),
  jobIds: z.array(z.string()),
  articles: z.array(
    z.object({ pmid: z.string(), title: z.string(), journal: z.string() }),
  ),
  text: z.string(),
});

const StoreSchema = z.object({
  version: z.literal(1),
  jobs: z.array(JobSchema),
  seenPmids: z.array(z.string()),
  articles: z.record(z.string(), ArticleSchema),
  summaries: z.array(SummarySchema),
  counters: z.object({
    ticks: z.number().int().nonnegative(),
    pubmedCalls: z.number().int().nonnegative(),
    pubmedErrors: z.number().int().nonnegative(),
    llmCalls: z.number().int().nonnegative(),
    skippedBudget: z.number().int().nonnegative(),
    missed: z.number().int().nonnegative(),
  }),
});

type Job = z.infer<typeof JobSchema>;
type Article = z.infer<typeof ArticleSchema>;
export type SchedulerSummary = z.infer<typeof SummarySchema>;
type Store = z.infer<typeof StoreSchema>;
type SchedulerCounters = Store["counters"];

function emptyStore(): Store {
  return {
    version: 1,
    jobs: [],
    seenPmids: [],
    articles: {},
    summaries: [],
    counters: {
      ticks: 0,
      pubmedCalls: 0,
      pubmedErrors: 0,
      llmCalls: 0,
      skippedBudget: 0,
      missed: 0,
    },
  };
}

/* ------------------------------ Service ---------------------------------- */

export class SchedulerService {
  private store: Store = emptyStore();
  private chain: Promise<unknown> = Promise.resolve();
  private tickTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly opts: {
      file: string;
      env: Env;
      deepSeek: DeepSeekService;
      ledger: UsageLedgerService;
      threads: ThreadStore;
    },
  ) {}

  /** Restore store from disk; broken file → empty store + warn (design §4.2). */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.opts.file, "utf8");
      const parsed = StoreSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.store = parsed.data;
      } else {
        console.warn("[scheduler] store parse failed — starting empty");
        this.store = emptyStore();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn("[scheduler] store load failed — starting empty");
      }
      this.store = emptyStore();
    }
  }

  start(): void {
    this.running = true;
    void this.restoreAndStart();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.tickTimer = null;
    this.summaryTimer = null;
  }

  snapshot(): {
    jobs: Job[];
    counters: SchedulerCounters & {
      pending: number;
      digested: number;
      articles: number;
    };
    lastSummary: SchedulerSummary | null;
  } {
    const all = Object.values(this.store.articles);
    return {
      jobs: this.store.jobs,
      counters: {
        ...this.store.counters,
        pending: all.filter((a) => a.state === "pending").length,
        digested: all.filter((a) => a.state === "digested").length,
        articles: all.length,
      },
      lastSummary: this.store.summaries[0] ?? null,
    };
  }

  /** MCP tool schedule_job. Throws "job_cap_reached" when active cap hit. */
  async scheduleJob(input: {
    query: string;
    everySec: number;
    ttlSec?: number;
  }): Promise<{ jobId: string; nextRunAt: string; active: true }> {
    const activeCount = this.store.jobs.filter((j) => j.active).length;
    if (activeCount >= ACTIVE_JOBS_MAX) {
      throw new Error("job_cap_reached");
    }
    const ttlSec = input.ttlSec ?? 86_400;
    const now = Date.now();
    const job: Job = {
      id: `job-${randomUUID().slice(0, 8)}`,
      query: input.query,
      everySec: input.everySec,
      ttlSec,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
      nextRunAt: now,
      lastRunAt: null,
      missed: 0,
      active: true,
    };
    // Whole-jobs cap (pass 04 п.1): FIFO by createdAt, prefer evicting inactive.
    while (this.store.jobs.length >= JOBS_MAX) {
      const order = [...this.store.jobs].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const victim = order.find((j) => !j.active) ?? order[0];
      this.store.jobs = this.store.jobs.filter((j) => j.id !== victim.id);
    }
    this.store.jobs.push(job);
    await this.persist();
    this.scheduleNextTick();
    return {
      jobId: job.id,
      nextRunAt: new Date(job.nextRunAt).toISOString(),
      active: true,
    };
  }

  cancelJob(id: string): boolean {
    const job = this.store.jobs.find((j) => j.id === id);
    if (!job) return false;
    job.active = false;
    void this.persist();
    return true;
  }

  /* ------------------------------ internals ------------------------------ */

  /** Boot restore: expire, skip-and-advance missed ticks, ≤1 catch-up tick. */
  private async restoreAndStart(): Promise<void> {
    const now = Date.now();
    let mostOverdue: Job | null = null;
    for (const job of this.store.jobs) {
      if (!job.active) continue;
      if (now > Date.parse(job.expiresAt)) {
        job.active = false;
        continue;
      }
      if (job.nextRunAt <= now) {
        let missed = 0;
        while (job.nextRunAt <= now) {
          job.nextRunAt += job.everySec * 1000;
          missed += 1;
        }
        job.missed += missed;
        this.store.counters.missed += missed;
        if (!mostOverdue || job.nextRunAt < mostOverdue.nextRunAt) {
          mostOverdue = job;
        }
      }
    }
    if (mostOverdue) {
      await this.runJobTick(mostOverdue, false);
    }
    await this.persist();
    if (this.running) {
      this.scheduleNextTick();
      this.scheduleSummaryTimer();
    }
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (!this.running) return;
    const active = this.store.jobs.filter((j) => j.active);
    if (active.length === 0) return;
    const next = Math.min(...active.map((j) => j.nextRunAt));
    const delay = Math.max(0, next - Date.now());
    this.tickTimer = setTimeout(() => {
      void this.onTick();
    }, delay);
  }

  private async onTick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const job of this.store.jobs) {
      if (!job.active) continue;
      if (now > Date.parse(job.expiresAt)) {
        job.active = false;
        continue;
      }
      if (job.nextRunAt <= now) {
        await this.runJobTick(job);
      }
    }
    await this.persist();
    await this.maybeRunSummary();
    this.scheduleNextTick();
  }

  /** PubMed collection — no LLM, ₽0 (design §4.1 TICK). */
  private async runJobTick(job: Job, advance = true): Promise<void> {
    job.lastRunAt = Date.now();
    if (advance) {
      job.nextRunAt = Date.now() + job.everySec * 1000;
    }
    this.store.counters.ticks += 1;
    try {
      const search = await esearch(job.query, {
        retmax: 20,
        reldateDays: ESEARCH_WINDOW_DAYS,
      });
      this.store.counters.pubmedCalls += 1;
      const known = new Set(this.store.seenPmids);
      const freshPmids = search.pmids.filter((p) => !known.has(p));
      if (freshPmids.length > 0) {
        const metas = await esummary(freshPmids);
        this.store.counters.pubmedCalls += 1;
        // Room first: overflow with no digested candidates drops new items
        // (pass 04 п.2) — unseen pmids stay unseen and retry next tick.
        const room = this.makeRoomForArticles(freshPmids.length);
        let added = 0;
        for (const pmid of freshPmids) {
          if (added >= room) break;
          const meta = metas.get(pmid);
          if (!meta) continue;
          // seen+metadata is one atomic mutation (pass 04 п.3) — an esummary
          // miss never burns the pmid.
          this.store.seenPmids.push(pmid);
          this.store.articles[pmid] = {
            pmid,
            title: meta.title,
            journal: meta.journal,
            pubdate: meta.pubdate,
            epubdate: meta.epubdate,
            authors: meta.authors,
            query: job.query,
            jobId: job.id,
            fetchedAt: new Date().toISOString(),
            state: "pending",
          };
          added += 1;
        }
        this.trimSeen();
        if (added < freshPmids.length) {
          this.store.counters.pubmedErrors += 1;
        }
      }
    } catch {
      this.store.counters.pubmedErrors += 1;
    }
  }

  private makeRoomForArticles(n: number): number {
    const entries = Object.entries(this.store.articles);
    let room = Math.max(0, ARTICLES_MAX - entries.length);
    if (room >= n) return room;
    const digested = entries
      .filter(([, a]) => a.state === "digested")
      .sort((a, b) => a[1].fetchedAt.localeCompare(b[1].fetchedAt));
    for (const [pmid] of digested) {
      if (room >= n) break;
      delete this.store.articles[pmid];
      room += 1;
    }
    return room;
  }

  private trimSeen(): void {
    while (this.store.seenPmids.length > SEEN_MAX) {
      this.store.seenPmids.shift();
    }
  }

  private pendingArticles(): Article[] {
    return Object.values(this.store.articles).filter(
      (a) => a.state === "pending",
    );
  }

  private lastJobQuery(): string {
    const [latest] = [...this.store.jobs].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return latest?.query ?? DEFAULT_QUERY;
  }

  /** Proactive digest — the only LLM caller in the scheduler (design §4.1). */
  private async maybeRunSummary(): Promise<void> {
    if (!this.running) return;
    if (!this.debouncePassed()) return;
    const hadMaterial = await this.ensureMaterial();
    if (!hadMaterial) return;
    if (!(await this.budgetAllows())) {
      this.store.counters.skippedBudget += 1;
      await this.persist();
      return;
    }
    await this.generateSummary();
    await this.persist();
    this.scheduleSummaryTimer();
  }

  private debouncePassed(): boolean {
    if (this.store.summaries.length === 0) return true; // first summary fires at once
    const latest = this.store.summaries[0]?.at;
    if (!latest) return true;
    const minMs = this.opts.env.SCHEDULE_SUMMARY_MIN_SEC * 1000;
    return Date.now() - Date.parse(latest) >= minMs;
  }

  private async ensureMaterial(): Promise<boolean> {
    if (this.pendingArticles().length > 0) return true;
    // archive-idle path (pending==0): deep-fetch a random history page.
    const term = this.lastJobQuery();
    try {
      const search = await esearch(term, { retmax: 1, retstart: randomInt(0, 300) });
      this.store.counters.pubmedCalls += 1;
      const known = new Set(this.store.seenPmids);
      const candidates = search.pmids.filter((p) => !known.has(p));
      if (candidates.length === 0) return false; // known pmid → skip this round
      const metas = await esummary(candidates);
      this.store.counters.pubmedCalls += 1;
      const room = this.makeRoomForArticles(1);
      if (room === 0) return false;
      for (const pmid of candidates) {
        const meta = metas.get(pmid);
        if (!meta) continue;
        this.store.seenPmids.push(pmid);
        this.store.articles[pmid] = {
          pmid,
          title: meta.title,
          journal: meta.journal,
          pubdate: meta.pubdate,
          epubdate: meta.epubdate,
          authors: meta.authors,
          query: term,
          jobId: null,
          fetchedAt: new Date().toISOString(),
          state: "pending",
        };
        this.trimSeen();
        return true;
      }
      return false;
    } catch {
      this.store.counters.pubmedErrors += 1;
      return false;
    }
  }

  private async budgetAllows(): Promise<boolean> {
    const limit = this.opts.env.DAILY_BUDGET_RUB;
    if (limit <= 0) return true;
    const totals = await this.opts.ledger.getTotals();
    return (totals.cost_rub_today ?? 0) < limit * BUDGET_MARGIN;
  }

  private async generateSummary(): Promise<void> {
    const pending = this.pendingArticles();
    const freshCutoff = Date.now() - FRESH_WINDOW_MS;
    const byFetched = (a: Article, b: Article) =>
      a.fetchedAt.localeCompare(b.fetchedAt);
    const fresh = pending
      .filter((a) => Date.parse(a.fetchedAt) >= freshCutoff)
      .sort(byFetched)
      .slice(0, SUMMARY_BATCH_MAX);
    let mode: "fresh" | "archive";
    let batch: Article[];
    if (fresh.length > 0) {
      mode = "fresh";
      batch = fresh;
    } else if (pending.length > 0) {
      mode = "archive";
      batch = [pending.sort(byFetched)[0]];
    } else {
      return;
    }

    const blocks: string[] = [];
    const refs: SchedulerSummary["articles"] = [];
    for (const article of batch) {
      try {
        const text = (await efetchAbstract(article.pmid)).slice(0, ABSTRACT_CAP);
        this.store.counters.pubmedCalls += 1;
        blocks.push(
          `PMID ${article.pmid} — «${article.title}» (${article.journal}, ${article.pubdate}):\n${text}`,
        );
        refs.push({
          pmid: article.pmid,
          title: article.title,
          journal: article.journal,
        });
      } catch {
        this.store.counters.pubmedErrors += 1;
      }
    }
    if (blocks.length === 0) return;

    const jobIds = [
      ...new Set(
        batch
          .map((a) => a.jobId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    try {
      const result = await this.opts.deepSeek.chat(
        [
          { role: "system", content: summarySystemPrompt(mode) },
          {
            role: "user",
            content:
              `${blocks.join("\n\n")}\n\n` +
              "Сделай по-русски краткий дайджест (3–5 предложений): что изучали, " +
              "главный результат, практический смысл при мышечной боли.",
          },
        ],
        {
          model: SUMMARY_MODEL,
          maxTokens: SUMMARY_MAX_TOKENS,
          timeoutMs: SUMMARY_TIMEOUT_MS,
          temperature: 0.4,
        },
      );
      // Background call is accounted like any other (design D-4/TR-7).
      await this.opts.ledger.record(result.usage);
      const summary: SchedulerSummary = {
        id: `sum-${Date.now()}`,
        at: new Date().toISOString(),
        mode,
        jobIds,
        articles: refs,
        text: result.reply,
      };
      this.store.summaries.unshift(summary);
      if (this.store.summaries.length > SUMMARIES_MAX) {
        this.store.summaries.length = SUMMARIES_MAX;
      }
      for (const article of batch) {
        const stored = this.store.articles[article.pmid];
        if (stored) {
          stored.state = "digested";
          stored.summaryId = summary.id;
        }
      }
      this.store.counters.llmCalls += 1;
      // Решение Кости 24.09 (вечер): сводка доставляется В ЧАТ — сообщение
      // ассистента в самом свежем треде (не только секция в доке).
      const target = this.opts.threads.latestThread();
      if (target) {
        const msg = this.opts.threads.createMessage({
          role: "assistant",
          content:
            `⏰ Сводка по расписанию — ${mode === "fresh" ? "свежие публикации PubMed" : "ретро-обзор из архива"}:\n\n${result.reply}`,
          label: "⏰ планировщик",
          model: SUMMARY_MODEL,
          latency_ms: result.latency_ms,
          usage: result.usage,
          cost_rub: costRubFromUsage(result.usage),
        });
        this.opts.threads.append(target.instanceId, target.agentId, msg);
      }
    } catch (error) {
      console.warn(
        "[scheduler] summary LLM call failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private scheduleSummaryTimer(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    if (!this.running) return;
    const minMs = this.opts.env.SCHEDULE_SUMMARY_MIN_SEC * 1000;
    const latest = this.store.summaries[0]?.at;
    const delay = latest
      ? Math.max(0, Date.parse(latest) + minMs - Date.now())
      : 0;
    this.summaryTimer = setTimeout(() => {
      void this.maybeRunSummary().then(() => this.scheduleSummaryTimer());
    }, delay);
  }

  /** Serialized atomic writes (tmp+rename) — same pattern as usage-ledger. */
  private persist(): Promise<void> {
    const run = this.chain.then(
      () => this.writeStore(),
      () => this.writeStore(),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeStore(): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.store, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.opts.file);
  }
}

function randomInt(minInclusive: number, maxExclusive: number): number {
  return minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive));
}

function summarySystemPrompt(mode: "fresh" | "archive"): string {
  const scope =
    mode === "fresh"
      ? "Это сводка по свежим публикациям последних недель."
      : "Свежих публикаций нет — это ретро-обзор одной более ранней статьи из архива.";
  return (
    "Ты готовишь краткий дайджест научных публикаций PubMed для приложения " +
    "самомассажа Trigger Helper. " +
    scope +
    " Отвечай по-русски, 3–5 предложений: что изучали, главный результат, " +
    "практический смысл для человека с мышечной болью. Ничего не выдумывай — " +
    "используй только предоставленные материалы; если данных мало, так и скажи."
  );
}

export function createSchedulerService(opts: {
  env: Env;
  deepSeek: DeepSeekService;
  ledger: UsageLedgerService;
  threads: ThreadStore;
}): SchedulerService {
  const file = opts.env.SCHEDULER_FILE
    ? path.resolve(opts.env.SCHEDULER_FILE)
    : path.join(repoRoot, "var", "scheduler.json");
  return new SchedulerService({ ...opts, file });
}
