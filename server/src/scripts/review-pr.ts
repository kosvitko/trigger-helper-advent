import { loadEnv } from "../config/env.js";
import type { ReviewFile } from "../services/review.js";
import { createReviewService } from "../services/review.js";
import { printReview, saveReviewArtifact } from "./review-common.js";

/**
 * Day32 · режим PR: AI-ревью реального pull request на GitHub (буквальный
 * минимум задания — «пайплайн запускается на PR»). Публичный outbox
 * читается без токена; приватный product-репо — с GITHUB_TOKEN в env.
 *
 *   npm run review:pr -- 7                                  (outbox по умолчанию)
 *   npm run review:pr -- 7 --repo=kosvitko/trigger-helper
 *
 * Выход: 0 — ревью получено (вердикт informational); 1 — сбой (нет PR/сеть).
 */

const DEFAULT_REPO = "kosvitko/trigger-helper-advent";
const GH_API = "https://api.github.com";

type PrMeta = { title?: string; changed_files?: number; head?: { sha?: string } };

async function ghText(path: string, accept: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "trigger-helper-review",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`${GH_API}${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} ${path}: ${body.slice(0, 200)}`);
  }
  return response.text();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const prArg = args.find((a) => /^\d+$/.test(a));
  const repoArg = args.find((a) => a.startsWith("--repo="));
  const repo = repoArg ? repoArg.slice("--repo=".length) : DEFAULT_REPO;
  if (!prArg) {
    console.error("Использование: npm run review:pr -- <номер-PR> [--repo=owner/name]");
    return 1;
  }
  const pr = Number(prArg);
  const env = loadEnv();
  console.log(`[review:pr] PR #${pr} · ${repo}`);
  try {
    const metaRaw = await ghText(`/repos/${repo}/pulls/${pr}`, "application/vnd.github+json");
    const meta = JSON.parse(metaRaw) as PrMeta;
    const diff = await ghText(`/repos/${repo}/pulls/${pr}`, "application/vnd.github.diff");
    const filesRaw = await ghText(
      `/repos/${repo}/pulls/${pr}/files?per_page=100`,
      "application/vnd.github+json",
    );
    const files = (JSON.parse(filesRaw) as Array<{ filename?: string; status?: string }>)
      .filter((f) => typeof f.filename === "string")
      .map((f): ReviewFile => ({ status: f.status ?? "M", path: f.filename! }));

    const service = createReviewService({ env });
    const result = await service.review({
      source: `PR #${pr} ${repo}`,
      title: meta.title ?? "",
      files,
      diff,
    });
    const artifact = await saveReviewArtifact(result);
    printReview(result, artifact);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[review:pr] сбой: ${message}`);
    return 1;
  }
}

process.exit(await main());
