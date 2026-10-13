import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import type { CorpusFile } from "./corpus.js";
import { repoRoot } from "./paths.js";

/**
 * Day31 project RAG corpus (design D-31-5/12): README + STACK + shared schemas.
 * Day32 (гейт 261013, Pick D): + код сервера и клиента — «документация + код»
 * для AI-ревью; chunking остаётся существующий structured (адаптация чанков
 * под код — вне дня, честно в NOTES).
 */

const CORPUS_README = "README.md";
const CORPUS_STACK = "docs/STACK.md";
const SCHEMAS_DIR = "shared/src/schemas";
const CODE_DIRS: Array<{ dir: string; ext: string }> = [
  { dir: "server/src", ext: ".ts" },
  { dir: "client/src", ext: ".ts" },
  { dir: "client/src", ext: ".svelte" },
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

export class ProjectCorpusReader {
  constructor(private readonly root: string = repoRoot) {}

  async listSources(): Promise<string[]> {
    const sources: string[] = [];
    for (const fixed of [CORPUS_README, CORPUS_STACK]) {
      if (await exists(path.join(this.root, fixed))) sources.push(fixed);
    }
    const schemaDir = path.join(this.root, SCHEMAS_DIR);
    if (await exists(schemaDir)) {
      for await (const rel of glob("**/*.ts", { cwd: schemaDir })) {
        sources.push(path.posix.join(SCHEMAS_DIR, rel.split(path.sep).join("/")));
      }
    }
    for (const { dir, ext } of CODE_DIRS) {
      const abs = path.join(this.root, dir);
      if (!(await exists(abs))) continue;
      for await (const rel of glob(`**/*${ext}`, { cwd: abs })) {
        sources.push(path.posix.join(dir, rel.split(path.sep).join("/")));
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
      const text = normalizeText(raw);
      if (!text.trim()) {
        console.log(`[rag/project-corpus] skip empty file: ${source}`);
        continue;
      }
      const isMarkdown = source.endsWith(".md");
      files.push({
        source,
        file: path.basename(source),
        title: isMarkdown ? (firstH1(text) ?? path.basename(source)) : path.basename(source),
        text,
      });
    }
    return files;
  }
}

export function createProjectCorpusReader(root?: string): ProjectCorpusReader {
  return new ProjectCorpusReader(root);
}
