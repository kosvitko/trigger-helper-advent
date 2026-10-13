import { loadEnv } from "../config/env.js";
import { createReviewService } from "../services/review.js";
import { collectRange, printReview, saveReviewArtifact } from "./review-common.js";

/**
 * Day32 · ручной режим: AI-ревью локального коммита/диапазона до пуша.
 *
 *   npm run review:commit                (HEAD~1..HEAD)
 *   npm run review:commit -- main..HEAD
 *
 * Выход: 0 — ревью получено (вердикт informational, любой); 1 — сбой.
 */

async function main(): Promise<number> {
  const range = process.argv[2] ?? "HEAD~1..HEAD";
  console.log(`[review:commit] диапазон ${range}`);
  try {
    const env = loadEnv();
    const { files, diff } = await collectRange(range);
    if (!diff.trim()) {
      console.log("[review:commit] пустой diff — ревьюить нечего");
      return 0;
    }
    const service = createReviewService({ env });
    const result = await service.review({ source: `commit ${range}`, title: "", files, diff });
    const artifact = await saveReviewArtifact(result);
    printReview(result, artifact);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[review:commit] сбой: ${message}`);
    return 1;
  }
}

process.exit(await main());
