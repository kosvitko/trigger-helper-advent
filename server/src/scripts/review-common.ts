import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "../services/rag/paths.js";
import {
  renderReviewMarkdown,
  type ReviewFile,
  type ReviewResult,
} from "../services/review.js";

/**
 * Day32: общий слой CLI-триггеров review-* — git-команды (cwd = корень репо),
 * разбор name-status, артефакт temp/reviews/*.md (temp/ в .gitignore).
 */

const execFileAsync = promisify(execFile);

/** Генерируемые артефакты не ревьюим как текст (эмбеддинги-JSON забьют кап);
 *  в списке файлов остаются, из тела diff исключены. */
const REVIEW_DIFF_EXCLUDES = [":(exclude)data/project-rag"];

export async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export function parseNameStatus(out: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    // R100/C75 → R/C: скоры git только шумят промпт ревью.
    const [rawStatus, ...rest] = parts;
    const status = rawStatus.trim().replace(/\d+$/, "");
    const from = rest[0] ?? "";
    const to = rest[1];
    files.push({
      status,
      path: to && to !== from ? `${from} → ${to}` : from,
    });
  }
  return files;
}

export async function collectRange(range: string): Promise<{ files: ReviewFile[]; diff: string }> {
  const nameStatus = await git(["diff", "--no-color", "--name-status", range]);
  const diff = await git(["diff", "--no-color", range, "--", ...REVIEW_DIFF_EXCLUDES]);
  return { files: parseNameStatus(nameStatus), diff };
}

/** Диапазон для pre-push: обновление ветки — remote..local; новая ветка —
 *  merge-base с origin/main (fallback: последний коммит). */
export async function resolvePushRange(localSha: string, remoteSha: string): Promise<string> {
  const zeros = "0".repeat(40);
  if (remoteSha !== zeros) return `${remoteSha}..${localSha}`;
  try {
    const base = (await git(["merge-base", localSha, "origin/main"])).trim();
    if (base) return `${base}..${localSha}`;
  } catch {
    // нет origin/main — последний коммит
  }
  return `${localSha}~1..${localSha}`;
}

export async function saveReviewArtifact(result: ReviewResult): Promise<string> {
  const dir = path.join(repoRoot, "temp", "reviews");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = [
    "review",
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`,
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`,
  ].join("-");
  const file = path.join(dir, `${name}.md`);
  await fs.writeFile(file, renderReviewMarkdown(result), "utf8");
  return file;
}

export function printReview(result: ReviewResult, artifact?: string): void {
  console.log(renderReviewMarkdown(result));
  if (artifact) console.log(`\n[review] артефакт: ${artifact}`);
}
