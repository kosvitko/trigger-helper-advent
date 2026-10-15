import fs from "node:fs/promises";
import path from "node:path";
import type { CorpusFile } from "./corpus.js";
import { repoRoot } from "./paths.js";

/**
 * Day33 support RAG corpus (гейт 261014, Pick A): пользовательская
 * документация — FAQ + README + дисклеймер + атлас. Только markdown: код
 * и внутренние стратегии не входят (вытесняют FAQ из поиска, риск утечки).
 */

const CORPUS_FILES = [
  "docs/product/faq.md",
  "README.md",
  "docs/product/disclaimer.md",
  "docs/product/atlas.md",
];

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .trimEnd();
}

function firstH1(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith("# ") && l.slice(2).trim().length > 0);
  return line ? line.slice(2).trim() : undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class SupportCorpusReader {
  constructor(private readonly root: string = repoRoot) {}

  async listSources(): Promise<string[]> {
    const sources: string[] = [];
    for (const fixed of CORPUS_FILES) {
      if (await exists(path.join(this.root, fixed))) {
        sources.push(fixed);
      } else {
        console.log(`[rag/support-corpus] skip missing file: ${fixed}`);
      }
    }
    return sources;
  }

  async readAll(): Promise<CorpusFile[]> {
    const sources = await this.listSources();
    const files: CorpusFile[] = [];
    for (const source of sources) {
      const raw = await fs.readFile(path.join(this.root, source), "utf8");
      const text = normalizeText(raw);
      if (!text.trim()) {
        console.log(`[rag/support-corpus] skip empty file: ${source}`);
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

export function createSupportCorpusReader(root?: string): SupportCorpusReader {
  return new SupportCorpusReader(root);
}
