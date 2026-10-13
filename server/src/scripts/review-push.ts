import { loadEnv } from "../config/env.js";
import { createReviewService } from "../services/review.js";
import {
  collectRange,
  printReview,
  resolvePushRange,
  saveReviewArtifact,
} from "./review-common.js";

/**
 * Day32 · строгий режим pre-push (гейт Кости 261013: «пуш только после
 * approve; нет approve — нет пуша»). Вызывается хуком .githooks/pre-push:
 *
 *   npm run review:push -- <local_ref> <local_sha> <remote_ref> <remote_sha>
 *
 * Без аргументов читает те же строки со stdin (ручной запуск/отладка).
 * Выход: 0 — все пушимые диапазоны approved (пуш продолжается);
 *        1 — блок: вердикт changes_requested или сбой ревью (strict).
 * Обход (осознанный, виден в истории shell): REVIEW_SKIP=1 | git push --no-verify.
 */

const ZEROS = "0".repeat(40);

type RefLine = { localRef: string; localSha: string; remoteRef: string; remoteSha: string };

async function readRefLines(args: string[]): Promise<RefLine[]> {
  if (args.length >= 4) {
    return [{ localRef: args[0]!, localSha: args[1]!, remoteRef: args[2]!, remoteSha: args[3]! }];
  }
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return localRef && localSha && remoteRef && remoteSha
        ? { localRef, localSha, remoteRef, remoteSha }
        : null;
    })
    .filter((ref): ref is RefLine => ref !== null);
}

async function main(): Promise<number> {
  if (process.env.REVIEW_SKIP === "1") {
    console.log("[review:push] REVIEW_SKIP=1 — ревью пропущено");
    return 0;
  }
  const refLines = await readRefLines(process.argv.slice(2));
  if (refLines.length === 0) {
    console.log("[review:push] нет пушимых рефов — ок");
    return 0;
  }
  const env = loadEnv();
  const service = createReviewService({ env });
  let approved = true;

  for (const ref of refLines) {
    if (ref.localSha === ZEROS) continue; // удаление remote-рефа — не ревьюим
    try {
      const range = await resolvePushRange(ref.localSha, ref.remoteSha);
      console.log(`[review:push] ${ref.localRef} → ${ref.remoteRef} · диапазон ${range}`);
      const { files, diff } = await collectRange(range);
      if (!diff.trim()) {
        console.log("[review:push] пустой diff — пропускаю реф");
        continue;
      }
      const result = await service.review({
        source: `push ${range}`,
        title: ref.localRef,
        files,
        diff,
      });
      const artifact = await saveReviewArtifact(result);
      printReview(result, artifact);
      if (result.verdict !== "approved") approved = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[review:push] сбой ревью рефа ${ref.localRef}: ${message}`);
      approved = false; // strict: нет ревью → нет approve → блок
    }
  }

  if (!approved) {
    console.error("\n[review:push] 🚫 ПУШ ЗАБЛОКИРОВАН — ревью не аппрувнуло изменения.");
    console.error("[review:push] Обход (осознанно): REVIEW_SKIP=1 git push … или git push --no-verify");
    return 1;
  }
  console.log("\n[review:push] ✅ ревью approved — пуш продолжается");
  return 0;
}

process.exit(await main());
