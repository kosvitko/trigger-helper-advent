import fs from "node:fs/promises";
import path from "node:path";
import type { ToolSpec } from "./deepseek.js";
import { repoRoot } from "./rag/paths.js";
import { FILES_WORKSPACE_REL } from "./repo-tools.js";

/**
 * Day34 (гейт 261015, Pick A/mid): in-process files-инструмент — запись
 * артефактов ассистента в workspace var/files-workspace/. Jail: только этот
 * каталог, расширения .md/.json, контент ≤16k симв; запись атомарная
 * (tmp+rename, паттерн usage-ledger). Живые файлы репозитория не изменяет —
 * на выходе unified diff против прежней версии workspace-файла. Паттерн
 * repo-tools/crm-tools (дни 31/33): MCP-эквивалент in-process.
 */

export const FILES_WRITE_TOOL = "files_write";

const CLIP_CHAR_CAP = 4_000;
const CONTENT_CHAR_CAP = 16_000;
const ALLOWED_WRITE_EXT = new Set([".md", ".json"]);

export type FilesToolDispatchResult = {
  ok: boolean;
  text: string;
  clip: string;
};

function clipText(text: string, max = CLIP_CHAR_CAP): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fail(text: string): FilesToolDispatchResult {
  return { ok: false, text, clip: clipText(text) };
}

function workspaceRoot(): string {
  return path.join(repoRoot, ...FILES_WORKSPACE_REL.split("/"));
}

type DiffOp = { op: "equal" | "delete" | "add"; line: string };

/** LCS-диф строк; на больших файлах (DP > 2M ячеек) — префикс/суффикс-fallback. */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  if (oldLines.length * newLines.length > 2_000_000) {
    return [
      ...oldLines.slice(0, start).map((line) => ({ op: "equal" as const, line })),
      ...oldLines.slice(start, endOld).map((line) => ({ op: "delete" as const, line })),
      ...newLines.slice(start, endNew).map((line) => ({ op: "add" as const, line })),
      ...oldLines.slice(endOld).map((line) => ({ op: "equal" as const, line })),
    ];
  }
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ op: "equal", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: "delete", line: oldLines[i] });
      i++;
    } else {
      ops.push({ op: "add", line: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: "delete", line: oldLines[i] });
    i++;
  }
  while (j < m) {
    ops.push({ op: "add", line: newLines[j] });
    j++;
  }
  return ops;
}

/** Unified-подобный диф: ханки с контекстом ±3 строки. */
function unifiedDiff(rel: string, oldText: string | null, newText: string): string {
  const newLines = newText.replace(/\r\n?/g, "\n").split("\n");
  if (oldText === null) {
    return [`new file: ${rel}`, ...newLines.map((l) => `+${l}`)].join("\n");
  }
  const oldLines = oldText.replace(/\r\n?/g, "\n").split("\n");
  const ops = diffLines(oldLines, newLines);
  let oldNo = 0;
  let newNo = 0;
  const rows = ops.map((o) => ({
    op: o.op,
    line: o.line,
    oldNo: o.op === "add" ? 0 : ++oldNo,
    newNo: o.op === "delete" ? 0 : ++newNo,
  }));
  const CONTEXT = 3;
  const isChange = (r: { op: DiffOp["op"] }): boolean => r.op !== "equal";
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!isChange(rows[i])) {
      i++;
      continue;
    }
    // Кластер: подряд изменения + короткие (≤2*CONTEXT) прогоны equal.
    let end = i;
    let lastChange = i;
    while (end < rows.length) {
      if (isChange(rows[end])) {
        lastChange = end;
        end++;
        continue;
      }
      let run = end;
      while (run < rows.length && !isChange(rows[run])) run++;
      if (run < rows.length && run - end <= 2 * CONTEXT) {
        end = run;
        continue;
      }
      break;
    }
    const hunkStart = Math.max(0, i - CONTEXT);
    const hunkEnd = Math.min(rows.length, lastChange + 1 + CONTEXT);
    const hunk = rows.slice(hunkStart, hunkEnd);
    const oldSide = hunk.filter((r) => r.op !== "add");
    const newSide = hunk.filter((r) => r.op !== "delete");
    const oldStart = oldSide.length
      ? oldSide[0].oldNo
      : hunkStart > 0
        ? rows[hunkStart - 1].oldNo + 1
        : 1;
    const newStart = newSide.length
      ? newSide[0].newNo
      : hunkStart > 0
        ? rows[hunkStart - 1].newNo + 1
        : 1;
    out.push(`@@ -${oldStart},${oldSide.length} +${newStart},${newSide.length} @@`);
    for (const r of hunk) {
      out.push(r.op === "add" ? `+${r.line}` : r.op === "delete" ? `-${r.line}` : ` ${r.line}`);
    }
    i = hunkEnd;
  }
  if (out.length === 0) return "без изменений";
  return out.join("\n");
}

export function buildFilesWriteToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: FILES_WRITE_TOOL,
      description:
        "Записать файл-артефакт (справочник, README, changelog, данные) в рабочее пространство " +
        `${FILES_WORKSPACE_REL}/ (только .md/.json, перезапись целиком; живые файлы репозитория не изменяются). ` +
        "Возвращает unified diff против прежней версии файла.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Путь относительно ${FILES_WORKSPACE_REL}/ (например reports/summary.md).`,
          },
          content: { type: "string", description: "Полное новое содержимое файла." },
        },
        required: ["path", "content"],
      },
    },
  };
}

export function buildFilesToolSpecs(): ToolSpec[] {
  return [buildFilesWriteToolSpec()];
}

async function runWriteFile(args: Record<string, unknown>): Promise<FilesToolDispatchResult> {
  const rel = typeof args.path === "string" ? args.path.trim().replace(/\\/g, "/") : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!rel) return fail("files_write: path обязателен");
  if (rel.includes("..") || rel.includes("\0") || /^[/\\]/.test(rel) || /^[a-zA-Z]:/.test(rel)) {
    return fail("files_write: путь вне workspace");
  }
  if (!ALLOWED_WRITE_EXT.has(path.posix.extname(rel).toLowerCase())) {
    return fail("files_write: только .md или .json");
  }
  if (!content) return fail("files_write: content обязателен");
  if (content.length > CONTENT_CHAR_CAP) {
    return fail(`files_write: content больше ${CONTENT_CHAR_CAP} симв`);
  }
  const root = workspaceRoot();
  const abs = path.join(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return fail("files_write: путь вне workspace");
  }
  let oldText: string | null = null;
  try {
    oldText = await fs.readFile(abs, "utf8");
  } catch {
    // нового файла ещё нет — diff будет «new file»
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
  const diff = unifiedDiff(`${FILES_WORKSPACE_REL}/${rel}`, oldText, content);
  const text = `записано: ${FILES_WORKSPACE_REL}/${rel} (${content.length} симв)\n${diff}`;
  return { ok: true, text, clip: clipText(text) };
}

export async function dispatchFilesTool(
  name: string,
  args: Record<string, unknown>,
): Promise<FilesToolDispatchResult> {
  if (name === FILES_WRITE_TOOL) return runWriteFile(args);
  const text = `unknown files tool: ${name}`;
  return { ok: false, text, clip: clipText(text) };
}

// --- Day34 cust-fix (Костя 15.10): рельс «просил артефакт — ход записал» ---
// Реплики юзера естественные, без имён тулзов/файлов; сервер сам понимает
// намерение и (в llm-agent) дожимает ход до files_write одним re-prompt'ом.

/** Глаголы «сделай артефакт». */
const FILES_RAIL_SAVE_VERBS =
  /(сохрани|запиши|выгрузи|оформи|сгенерируй|перепиши|перезапиши|пересобери|собери)/i;
/** Глаголы изменения (требуют цель/анафору рядом). */
const FILES_RAIL_MUTATE_VERBS =
  /(обнови|дополни|добавь|убери|доработай|расширь|поменяй|исправь)/i;
/** Цель/анафора артефакта: «добавь туда раздел», «обнови справочник». */
const FILES_RAIL_TARGETS =
  /(файл|справочник|readme|changelog|документ|раздел|заметк|информац|туда|него|в н[её]м)/i;
/** Чтение без изменения — запись не требуется. */
const FILES_RAIL_READ_INTENT =
  /(покажи|выведи|прочитай|что записано|что в файле|содержимое|открой)/i;

/** true — реплика пользователя просит создать/обновить файловый артефакт. */
export function filesRailWantsArtifact(input: string): boolean {
  const text = input.toLowerCase();
  if (FILES_RAIL_READ_INTENT.test(text)) return false;
  if (FILES_RAIL_SAVE_VERBS.test(text)) return true;
  return FILES_RAIL_MUTATE_VERBS.test(text) && FILES_RAIL_TARGETS.test(text);
}
