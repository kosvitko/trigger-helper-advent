import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import type { CorpusFile } from "./corpus.js";
import { repoRoot } from "./paths.js";

/**
 * Day31 project RAG corpus (design D-31-5/12): README + STACK + shared schemas only.
 */

const CORPUS_README = "README.md";
const CORPUS_STACK = "docs/STACK.md";
const SCHEMAS_GLOB = "shared/src/schemas/**/*.ts";

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
    const schemaDir = path.join(this.root, "shared/src/schemas");
    if (await exists(schemaDir)) {
      for await (const rel of glob("**/*.ts", { cwd: schemaDir })) {
        sources.push(path.posix.join("shared/src/schemas", rel.split(path.sep).join("/")));
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
      const isSchemaTs = source.startsWith("shared/src/schemas/") && source.endsWith(".ts");
      files.push({
        source,
        file: path.basename(source),
        title: isSchemaTs ? path.basename(source) : (firstH1(text) ?? path.basename(source)),
        text,
      });
    }
    return files;
  }
}

export function createProjectCorpusReader(root?: string): ProjectCorpusReader {
  return new ProjectCorpusReader(root);
}
