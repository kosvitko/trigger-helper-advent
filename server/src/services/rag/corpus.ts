import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./paths.js";

/**
 * Day22 corpus (design D-12, addendum): point cards — one md file per muscle
 * in data/points/ (rendered by tools/content-pipeline/render_cards.py from the
 * pipeline draft). The day-21 docs/ corpus and its 17 probes live on in tag
 * week05-day21; the product RAG surface is the points knowledge base.
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

const POINTS_DIR = "data/points";

export class CorpusReader {
  constructor(private readonly root: string = repoRoot) {}

  async listSources(): Promise<string[]> {
    const sources: string[] = [];
    const pointsDir = path.join(this.root, POINTS_DIR);
    if (await exists(pointsDir)) {
      for (const entry of await fs.readdir(pointsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          sources.push(`${POINTS_DIR}/${entry.name}`);
        }
      }
    }
    sources.sort();
    return sources;
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
