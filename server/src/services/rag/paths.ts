import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Day21 (design §2/§4): single repoRoot for all rag modules.
 * Depth from server/src/services/rag/ (dist mirror is equidepth) to the repo
 * root is FOUR levels: rag → services → src → server → <repo>.
 * points.ts sits one level higher (3 levels) and scheduler.ts another —
 * neither is a template for this nested folder (pass 02b, CR-1).
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../../../..");

/** Resolve a configurable dir/file: explicit value wins, else repo-root-relative default. */
export function resolveFromRoot(custom: string | undefined, defaultRelative: string): string {
  return custom ? path.resolve(custom) : path.join(repoRoot, defaultRelative);
}
