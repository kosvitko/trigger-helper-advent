import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolSpec } from "./deepseek.js";
import { repoRoot } from "./rag/paths.js";

/**
 * Day31 (design D-31-4/4b/9/15): in-process repo tools — no public HTTP.
 */

const execFileAsync = promisify(execFile);

export const REPO_GIT_BRANCH_TOOL = "repo_git_branch";
export const REPO_LIST_FILES_TOOL = "repo_list_files";
export const REPO_READ_FILE_TOOL = "repo_read_file";
export const REPO_SEARCH_TOOL = "repo_search";

/** Day34: workspace артефактов files_write (files-tools.ts) — единственное
 * читаемое исключение внутри var/. */
export const FILES_WORKSPACE_REL = "var/files-workspace";

const READ_OUTPUT_CHAR_CAP = 3_800;
const CLIP_CHAR_CAP = 4_000;

const ALLOWED_READ_EXT = new Set([".ts", ".svelte", ".md", ".json"]);
const ALLOWED_LIST_ROOTS = [
  "server/src",
  "client/src",
  "shared/src",
  // Day34: workspace артефактов — листается/читается как обычный корень.
  FILES_WORKSPACE_REL,
] as const;

const SEARCH_MATCH_CAP = 50;
const SEARCH_QUERY_MAX = 200;

export type RepoToolDispatchResult = {
  ok: boolean;
  text: string;
  clip: string;
};

function clipText(text: string, max = CLIP_CHAR_CAP): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isDenied(rel: string): boolean {
  const norm = toPosixRel(rel);
  if (norm === "" || norm === ".") return false;
  if (norm.includes("..")) return true;
  const parts = norm.split("/");
  for (const part of parts) {
    if (part.startsWith(".env")) return true;
  }
  // Day34: workspace артефактов — единственное исключение запрета var/.
  if (norm === FILES_WORKSPACE_REL || norm.startsWith(`${FILES_WORKSPACE_REL}/`)) {
    return false;
  }
  if (norm === "var" || norm.startsWith("var/")) return true;
  if (norm.startsWith("node_modules/") || norm.includes("/node_modules/")) return true;
  if (norm === ".git" || norm.startsWith(".git/") || norm.includes("/.git/")) return true;
  if (norm === "docs/private" || norm.startsWith("docs/private/")) return true;
  if (norm === "docs/reviews" || norm.startsWith("docs/reviews/")) return true;
  if (norm === "agents_package" || norm.startsWith("agents_package/")) return true;
  if (norm.startsWith("docs/advent/")) {
    const base = path.posix.basename(norm);
    if (base.startsWith("DEPLOY")) return true;
  }
  return false;
}

function isAllowedReadRel(rel: string): boolean {
  if (isDenied(rel)) return false;
  const norm = toPosixRel(rel);
  if (norm === "README.md") return true;
  if (norm === "docs/STACK.md") return true;
  const okPrefix = ALLOWED_LIST_ROOTS.some((p) => norm.startsWith(`${p}/`));
  if (!okPrefix) return false;
  return ALLOWED_READ_EXT.has(path.posix.extname(norm).toLowerCase());
}

function isAllowedListDirRel(rel: string): boolean {
  if (isDenied(rel)) return false;
  const norm = toPosixRel(rel);
  if (norm === "" || norm === ".") return true;
  return ALLOWED_LIST_ROOTS.some((p) => norm === p || norm.startsWith(`${p}/`));
}

async function repoRootReal(): Promise<string> {
  return fs.realpath(repoRoot);
}

async function resolveInRepo(userPath: string, mustExist: boolean): Promise<{ rel: string; abs: string } | null> {
  if (typeof userPath !== "string" || !userPath.trim() || userPath.includes("\0")) return null;
  const cleaned = userPath.trim().replace(/\\/g, "/");
  if (cleaned.includes("..")) return null;
  const root = await repoRootReal();
  const abs = path.resolve(repoRoot, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (mustExist) {
    try {
      const real = await fs.realpath(abs);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      const rel = toPosixRel(path.relative(root, real));
      if (isDenied(rel)) return null;
      return { rel, abs: real };
    } catch {
      return null;
    }
  }
  const rel = toPosixRel(path.relative(root, abs));
  if (isDenied(rel)) return null;
  return { rel, abs };
}

export function buildRepoGitBranchToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: REPO_GIT_BRANCH_TOOL,
      description: "Текущая git-ветка репозитория Trigger Helper (read-only).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
}

export function buildRepoListFilesToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: REPO_LIST_FILES_TOOL,
      description:
        "Список имён файлов и каталогов: корень репо (dir пустой или \".\") " +
        "или подкаталог server/src, client/src, shared/src.",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description: 'Каталог относительно корня репо; "." или пусто — верхний уровень.',
          },
        },
      },
    },
  };
}

export function buildRepoReadFileToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: REPO_READ_FILE_TOOL,
      description:
        "Прочитать фрагмент файла из allowlist (server/src, client/src, shared/src, README.md, docs/STACK.md). " +
        "offset/limit — номера строк (1-based offset).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Путь относительно корня репозитория." },
          offset: { type: "number", description: "Первая строка (1-based), по умолчанию 1." },
          limit: { type: "number", description: "Число строк, по умолчанию до лимита символов." },
        },
        required: ["path"],
      },
    },
  };
}

export function buildRepoSearchToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: REPO_SEARCH_TOOL,
      description:
        "Поиск подстроки (без учёта регистра) по файлам репозитория из allowlist " +
        "(server/src, client/src, shared/src, var/files-workspace, README.md, docs/STACK.md); " +
        "возвращает «path:line: строка» — сам выбирай, что прочитать подробнее.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Искомая подстрока (идентификатор, имя тулзы, слово).",
          },
        },
        required: ["query"],
      },
    },
  };
}

export function buildRepoToolSpecs(): ToolSpec[] {
  return [
    buildRepoGitBranchToolSpec(),
    buildRepoListFilesToolSpec(),
    buildRepoReadFileToolSpec(),
    buildRepoSearchToolSpec(),
  ];
}

async function runGitBranch(): Promise<RepoToolDispatchResult> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    const branch = stdout.trim();
    if (!branch) {
      const text = "git: пустой вывод ветки";
      return { ok: false, text, clip: clipText(text) };
    }
    const text = `branch: ${branch}`;
    return { ok: true, text, clip: clipText(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = `git error: ${message}`;
    return { ok: false, text, clip: clipText(text) };
  }
}

async function runListFiles(args: Record<string, unknown>): Promise<RepoToolDispatchResult> {
  const dirArg = typeof args.dir === "string" ? args.dir.trim() : "";
  const dirRel = dirArg === "" || dirArg === "." ? "." : dirArg.replace(/\\/g, "/");
  if (!isAllowedListDirRel(dirRel === "." ? "" : dirRel)) {
    const text = "list_files: путь вне allowlist или запрещён";
    return { ok: false, text, clip: clipText(text) };
  }
  const root = await repoRootReal();
  const targetAbs = dirRel === "." ? root : path.join(root, dirRel);
  let entries;
  try {
    entries = await fs.readdir(targetAbs, { withFileTypes: true });
  } catch {
    const text = "list_files: каталог не найден или недоступен";
    return { ok: false, text, clip: clipText(text) };
  }
  const names: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRel = dirRel === "." ? entry.name : `${dirRel}/${entry.name}`;
    const posixChild = toPosixRel(childRel);
    if (isDenied(posixChild)) continue;
    if (entry.isDirectory()) {
      names.push(`${entry.name}/`);
      continue;
    }
    if (dirRel === ".") {
      names.push(entry.name);
      continue;
    }
    const ext = path.posix.extname(entry.name).toLowerCase();
    if (ALLOWED_READ_EXT.has(ext)) names.push(entry.name);
  }
  const text = names.length ? names.join("\n") : "(пусто)";
  return { ok: true, text, clip: clipText(text) };
}

async function runReadFile(args: Record<string, unknown>): Promise<RepoToolDispatchResult> {
  const filePath = typeof args.path === "string" ? args.path.trim() : "";
  if (!filePath) {
    const text = "read_file: path обязателен";
    return { ok: false, text, clip: clipText(text) };
  }
  const resolved = await resolveInRepo(filePath, true);
  if (!resolved || !isAllowedReadRel(resolved.rel)) {
    const text = "read_file: путь вне allowlist или запрещён";
    return { ok: false, text, clip: clipText(text) };
  }
  let raw: string;
  try {
    raw = await fs.readFile(resolved.abs, "utf8");
  } catch {
    const text = "read_file: файл не найден";
    return { ok: false, text, clip: clipText(text) };
  }
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const offset =
    typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset >= 1
      ? Math.floor(args.offset)
      : 1;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit >= 1
      ? Math.floor(args.limit)
      : lines.length;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, i) => `${offset + i}|${line}`);
  let text = `${resolved.rel}\n${numbered.join("\n")}`;
  if (text.length > READ_OUTPUT_CHAR_CAP) {
    text = `${text.slice(0, READ_OUTPUT_CHAR_CAP - 1)}…`;
  }
  return { ok: true, text, clip: clipText(text) };
}

async function collectSearchFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ALLOWED_LIST_ROOTS) {
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries;
      try {
        entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
      } catch {
        continue; // корня может не быть (workspace до первой записи)
      }
      for (const entry of entries) {
        const rel = `${dir}/${entry.name}`;
        if (isDenied(rel)) continue;
        if (entry.isDirectory()) {
          stack.push(rel);
          continue;
        }
        if (ALLOWED_READ_EXT.has(path.posix.extname(entry.name).toLowerCase())) {
          files.push(rel);
        }
      }
    }
  }
  files.push("README.md", "docs/STACK.md");
  return files.sort();
}

async function runSearch(args: Record<string, unknown>): Promise<RepoToolDispatchResult> {
  const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
  if (!rawQuery) {
    const text = "repo_search: query обязателен";
    return { ok: false, text, clip: clipText(text) };
  }
  if (rawQuery.length > SEARCH_QUERY_MAX) {
    const text = `repo_search: query длиннее ${SEARCH_QUERY_MAX} симв`;
    return { ok: false, text, clip: clipText(text) };
  }
  const needle = rawQuery.toLowerCase();
  const files = await collectSearchFiles();
  const lines: string[] = [];
  let matches = 0;
  for (const rel of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const rows = raw.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].toLowerCase().includes(needle)) continue;
      matches++;
      if (lines.length < SEARCH_MATCH_CAP) {
        lines.push(`${rel}:${i + 1}: ${rows[i].trim().slice(0, 160)}`);
      }
    }
  }
  const header =
    `найдено ${matches} совпадений по «${rawQuery}»` +
    (matches > SEARCH_MATCH_CAP ? ` (показаны первые ${SEARCH_MATCH_CAP})` : "");
  const text = lines.length ? `${header}\n${lines.join("\n")}` : header;
  return { ok: true, text, clip: clipText(text) };
}

export async function dispatchRepoTool(
  name: string,
  args: Record<string, unknown>,
): Promise<RepoToolDispatchResult> {
  switch (name) {
    case REPO_GIT_BRANCH_TOOL:
      return runGitBranch();
    case REPO_LIST_FILES_TOOL:
      return runListFiles(args);
    case REPO_READ_FILE_TOOL:
      return runReadFile(args);
    case REPO_SEARCH_TOOL:
      return runSearch(args);
    default: {
      const text = `unknown repo tool: ${name}`;
      return { ok: false, text, clip: clipText(text) };
    }
  }
}
