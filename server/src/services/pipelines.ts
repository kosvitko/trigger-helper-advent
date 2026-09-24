import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../config/env.js";
import type { DeepSeekService } from "./deepseek.js";
import type { UsageLedgerService } from "./usage-ledger.js";
import { efetchAbstract, esearch, esummary } from "./pubmed.js";

/**
 * Day19: pipeline tools — search → summarize → saveToFile (composition of
 * MCP tools). Design: docs/reviews/260924-day19-design.md §4; canon gate
 * §7 (Pick A, 24.09).
 *
 * - `search` — PubMed metadata only, no abstracts, ₽0 (D-3).
 * - `summarize` — the FIRST tool that calls the LLM (deepseek-chat,
 *   budget-guarded + ledger-recorded): day17 invariant "tools never call
 *   the LLM" is revised by the day19 gate (D-4). Usage is recorded here and
 *   never merged into the outer run — the provider counts the prompt in the
 *   next round anyway (no double accounting).
 * - `saveToFile` — the FIRST writing tool: sanitized filename, hard root,
 *   64 KB content cap, ≤20 files with mtime rotation, atomic tmp+rename —
 *   all catalog mutations through one serialized chain (pass 04 F-2);
 *   listing/rotation count whitelist names only, tmp never visible (pass 05 F-1).
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SEARCH_WINDOW_DAYS = 30; // reldate=30 — day18 pattern (pass 05 F-7)
const SEARCH_RETMAX_DEFAULT = 5;
const SEARCH_RETMAX_MAX = 20;
const QUERY_MAX = 120;
const PIPELINE_PMIDS_MAX = 5;
/** Per-abstract clip (×5 ≈ 20k chars of input — pass 05 F-8). */
const ABSTRACT_CAP = 4000;
/** Design D-4: nested summary uses deepseek-chat only (known price). */
const SUMMARY_MODEL = "deepseek-chat";
const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_MAX_TOKENS = 500;
/** Background ₽ gate margin — same as the scheduler (0.95×, design D-4). */
const BUDGET_MARGIN = 0.95;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(md|txt)$/;
const CONTENT_MAX = 64 * 1024;
const FILES_MAX = 20;

export class PipelineError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type PipelineArticleMeta = {
  pmid: string;
  title: string;
  journal: string;
  pubdate: string;
  authors: string[];
};

export type SavedFileInfo = { name: string; bytes: number; mtime: number };

export class PipelinesService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: {
      env: Env;
      deepSeek: DeepSeekService;
      ledger: UsageLedgerService;
    },
    private readonly root: string,
  ) {}

  /** Day19 D-3: PubMed search — compact metadata, no abstracts (₽0). */
  async search(params: {
    query: string;
    retmax?: number;
  }): Promise<{ count: number; articles: PipelineArticleMeta[] }> {
    const query = params.query.trim();
    if (query.length < 3 || query.length > QUERY_MAX) {
      throw new PipelineError("invalid_query");
    }
    const retmax = Math.min(
      Math.max(1, Math.floor(params.retmax ?? SEARCH_RETMAX_DEFAULT)),
      SEARCH_RETMAX_MAX,
    );
    const { count, pmids } = await esearch(query, {
      retmax,
      reldateDays: SEARCH_WINDOW_DAYS,
    });
    if (pmids.length === 0) {
      return { count: 0, articles: [] };
    }
    const metas = await esummary(pmids);
    const articles: PipelineArticleMeta[] = [];
    for (const pmid of pmids) {
      const meta = metas.get(pmid);
      if (meta) {
        articles.push({
          pmid,
          title: meta.title,
          journal: meta.journal,
          pubdate: meta.pubdate,
          authors: meta.authors,
        });
      }
    }
    return { count, articles };
  }

  /** Day19 D-4: summarize — the tool fetches abstracts itself, so the model
   *  copies only short pmids (data passing search → summarize). */
  async summarize(params: {
    pmids: string[];
    focus?: string;
  }): Promise<{ summary: string; pmids: string[] }> {
    const pmids = [
      ...new Set(params.pmids.map((p) => p.trim()).filter(Boolean)),
    ];
    if (pmids.length === 0 || pmids.length > PIPELINE_PMIDS_MAX) {
      throw new PipelineError("no_articles_found");
    }
    if (!(await this.budgetAllows())) {
      throw new PipelineError("budget_exceeded");
    }
    const blocks: string[] = [];
    const kept: string[] = [];
    for (const pmid of pmids) {
      try {
        const text = (await efetchAbstract(pmid)).slice(0, ABSTRACT_CAP);
        blocks.push(`PMID ${pmid}:\n${text}`);
        kept.push(pmid);
      } catch {
        // abstract unavailable — summarize the ones we did get
      }
    }
    if (blocks.length === 0) {
      throw new PipelineError("no_articles_found");
    }
    const focus = params.focus?.trim().slice(0, 200);
    try {
      const result = await this.opts.deepSeek.chat(
        [
          {
            role: "system",
            content:
              "Ты — шаг «summarize» MCP-пайплайна приложения самомассажа Trigger Helper. " +
              "Сделай по-русски краткую сводку подготовленных материалов PubMed (3–6 предложений): " +
              "что изучали, главный результат, практический смысл при мышечной боли. " +
              "Ничего не выдумывай — используй только предоставленные материалы; " +
              "если данных мало, так и скажи.",
          },
          {
            role: "user",
            content:
              blocks.join("\n\n") +
              (focus ? `\n\nФокус сводки: ${focus}` : ""),
          },
        ],
        {
          model: SUMMARY_MODEL,
          maxTokens: SUMMARY_MAX_TOKENS,
          timeoutMs: SUMMARY_TIMEOUT_MS,
          temperature: 0.4,
        },
      );
      // Nested call is accounted like any other (design D-4/TR-7).
      await this.opts.ledger.record(result.usage);
      return { summary: result.reply, pmids: kept };
    } catch (error) {
      throw new PipelineError(
        `summarize_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Day19 D-5: sanitized save into the hard root (first writing tool). */
  async saveToFile(params: {
    filename: string;
    content: string;
  }): Promise<{ path: string; bytes: number }> {
    const name = sanitizeFilename(params.filename);
    if (!name) {
      throw new PipelineError("invalid_filename");
    }
    const bytes = Buffer.byteLength(params.content ?? "", "utf8");
    if (bytes === 0 || bytes > CONTENT_MAX) {
      throw new PipelineError("content_too_large");
    }
    const target = path.resolve(this.root, name);
    if (!target.startsWith(this.root + path.sep)) {
      throw new PipelineError("invalid_filename");
    }
    await this.withCatalogLock(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, params.content, "utf8");
      await fs.rename(tmp, target);
      await this.rotateLocked();
      await this.cleanupTmpLocked();
    });
    return { path: target, bytes };
  }

  /** GET /api/pipelines — newest first; tmp never visible (pass 05 F-1). */
  async listFiles(): Promise<SavedFileInfo[]> {
    const files = await this.listWhitelisted();
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** Same sanitization as saveToFile; unknown name → null (404-shape). */
  async readFile(
    name: string,
  ): Promise<(SavedFileInfo & { content: string }) | null> {
    const safe = sanitizeFilename(name);
    if (!safe) return null;
    const target = path.resolve(this.root, safe);
    if (!target.startsWith(this.root + path.sep)) return null;
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return null;
      const content = await fs.readFile(target, "utf8");
      return { name: safe, bytes: stat.size, mtime: stat.mtimeMs, content };
    } catch {
      return null;
    }
  }

  private async budgetAllows(): Promise<boolean> {
    const limit = this.opts.env.DAILY_BUDGET_RUB;
    if (limit <= 0) return true;
    const totals = await this.opts.ledger.getTotals();
    return (totals.cost_rub_today ?? 0) < limit * BUDGET_MARGIN;
  }

  /** All catalog mutations (write + rotation) through one chain (pass 04 F-2). */
  private withCatalogLock<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    void run.then(
      () => undefined,
      () => undefined,
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Whitelist-matching files only — tmp intermediates invisible (pass 05 F-1). */
  private async listWhitelisted(): Promise<SavedFileInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: SavedFileInfo[] = [];
    for (const name of names) {
      if (!FILENAME_RE.test(name)) continue;
      try {
        const stat = await fs.stat(path.join(this.root, name));
        if (stat.isFile()) {
          out.push({ name, bytes: stat.size, mtime: stat.mtimeMs });
        }
      } catch {
        // raced deletion — skip
      }
    }
    return out;
  }

  /** ≤20 whitelist files after write; oldest mtime evicted (pass 05 F-6). */
  private async rotateLocked(): Promise<void> {
    const files = (await this.listWhitelisted()).sort(
      (a, b) => a.mtime - b.mtime,
    );
    const excess = files.slice(0, Math.max(0, files.length - FILES_MAX));
    for (const file of excess) {
      await fs.rm(path.join(this.root, file.name), { force: true });
    }
  }

  /** Orphaned tmp intermediates (e.g. after a crash) — swept on write. */
  private async cleanupTmpLocked(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        await fs
          .rm(path.join(this.root, name), { force: true })
          .catch(() => undefined);
      }
    }
  }
}

function sanitizeFilename(raw: string): string | null {
  const name = (raw ?? "").trim();
  return FILENAME_RE.test(name) ? name : null;
}

export function createPipelinesService(opts: {
  env: Env;
  deepSeek: DeepSeekService;
  ledger: UsageLedgerService;
}): PipelinesService {
  // D-5 (pass 05 confirmed): default depth `../../..` — same as usage-ledger
  // (services/ → repo root, verified on the VPS in day18); PIPELINES_DIR
  // absolute is the VPS norm (verify the actual path in the first smoke).
  const root = opts.env.PIPELINES_DIR
    ? path.resolve(opts.env.PIPELINES_DIR)
    : path.join(repoRoot, "var", "pipelines");
  return new PipelinesService(opts, root);
}
