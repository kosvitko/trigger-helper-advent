import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./paths.js";

/**
 * Day21 corpus (design D-1): README.md + all markdown under docs/ (any
 * depth), excluding docs/private/ and docs/reviews/_archive/ — private
 * notes must not reach the search surface exposed by days 22–25.
 */

export interface CorpusFile {
  /** Repo-relative path; also the index `source` field (e.g. "docs/STACK.md"). */
  source: string;
  /** Basename (index `file` field, e.g. "STACK.md"). */
  file: string;
  /** First H1 text; fallback = basename (pass 04, F-D). */
  title: string;
  text: string;
}

const EXCLUDED_DIR_NAMES = new Set(["private", "_archive"]);

export class CorpusReader {
  constructor(private readonly root: string = repoRoot) {}

  async listSources(): Promise<string[]> {
    const sources: string[] = [];
    const readme = path.join(this.root, "README.md");
    if (await exists(readme)) {
      sources.push("README.md");
    }
    const docsDir = path.join(this.root, "docs");
    if (await exists(docsDir)) {
      await this.walk(docsDir, "docs", sources);
    }
    sources.sort();
    return sources;
  }

  private async walk(absDir: string, relDir: string, out: string[]): Promise<void> {
    for (const entry of await fs.readdir(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        await this.walk(path.join(absDir, entry.name), rel, out);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(rel);
      }
    }
  }

  async readAll(): Promise<CorpusFile[]> {
    const sources = await this.listSources();
    const files: CorpusFile[] = [];
    for (const source of sources) {
      const raw = await fs.readFile(path.join(this.root, source), "utf8");
      // Normalize CRLF, strip zero-width chars (design D-1; RU/UTF-8 pitfalls).
      const text = raw
        .replace(/\r\n?/g, "\n")
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
        .trimEnd();
      if (!text.trim()) {
        console.log(`[rag/corpus] skip empty file: ${source}`);
        continue;
      }
      files.push({
        source,
        file: path.basename(source),
        title: firstH1(text) ?? path.basename(source),
        text,
      });
    }
    return files;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function firstH1(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith("# ") && l.slice(2).trim().length > 0);
  return line ? line.slice(2).trim() : undefined;
}

export function createCorpusReader(root?: string): CorpusReader {
  return new CorpusReader(root);
}
