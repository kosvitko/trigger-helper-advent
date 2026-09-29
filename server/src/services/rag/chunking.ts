import { estimateTokens } from "../agent/token-estimate.js";
import type { CorpusFile } from "./corpus.js";

/**
 * Day21 chunking (design D-8). Token budget is PRIMARY:
 * estimateTokens(chunk) ≤ CHUNK_TOKEN_BUDGET (~450, headroom under the e5-512
 * cap incl. the "passage: " prefix). Char sizes are guidance only
 * (RU ≈1000–1100, latin ≈1200–1500, hard cap HARD_CHAR_CAP).
 *
 * - fixed: window by budget, 15% overlap, cuts at paragraph boundaries,
 *   never inside code fences; oversized single paragraph (big fences/tables)
 *   falls back to sentence boundaries, then to a hard char cut (pass 04, F-C).
 * - structured: split by ATX headers level ≤3 ("####"+ stay inside their
 *   section); oversized sections are re-chunked with the fixed assembler,
 *   tiny (<200 chars) sections merge into a sibling (pass 02, F3 / 02b).
 * - fixed chunks still carry `section`: the header path active at chunk
 *   start ("" before the first header) — pass 02b, CR-8.
 */

export const CHUNK_TOKEN_BUDGET = 450;
export const OVERLAP_RATIO = 0.15;
export const OVERLAP_TOKEN_BUDGET = Math.round(CHUNK_TOKEN_BUDGET * OVERLAP_RATIO);
export const HARD_CHAR_CAP = 1500;
export const MERGE_MIN_CHARS = 200;

export type RagStrategy = "fixed" | "structured";

export interface ChunkDraft {
  chunk_id: string;
  source: string;
  file: string;
  title: string;
  section: string;
  position: number;
  text: string;
}

interface Header {
  level: number; // 1..3
  text: string;
  offset: number; // char offset in file text
}

interface Piece {
  text: string;
  offset: number; // char offset in file text
}

interface Slot {
  text: string;
  start: number; // char offset
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SECTION_SEP = " › ";
/** Markdown list item line — cuts between items are block-boundary cuts. */
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;

/* ------------------------------------------------------------------ */
/* Fence-aware scanner                                                 */
/* ------------------------------------------------------------------ */

class FenceScanner {
  /* checked by callers after feed(): a header line inside a fence is content */
  inFence = false;
  private fenceChar = "";

  /** Feed a line: "open" = fence start, "close" = fence end, null = content. */
  feed(line: string): "open" | "close" | null {
    const m = FENCE_RE.exec(line);
    if (!m) return null;
    const marker = m[1];
    if (!this.inFence) {
      this.inFence = true;
      this.fenceChar = marker[0];
      return "open";
    }
    if (marker[0] === this.fenceChar) {
      this.inFence = false;
      return "close";
    }
    return null; // a different marker line inside a fence is content
  }
}

/** Headers (level ≤3) outside code fences, with char offsets. */
function scanHeaders(text: string): Header[] {
  const headers: Header[] = [];
  const scanner = new FenceScanner();
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = scanner.feed(line);
    if (marker === null && !scanner.inFence) {
      const h = ATX_RE.exec(line);
      if (h && h[1].length <= 3) {
        headers.push({ level: h[1].length, text: h[2].trim(), offset });
      }
    }
    offset += line.length + 1;
  }
  return headers;
}

/** Header path ("H1 › H2 › H3", last active per level) at a char offset. */
function headerPathAt(headers: Header[], pos: number): string {
  const byLevel = new Map<number, string>();
  for (const h of headers) {
    if (h.offset > pos) break;
    byLevel.set(h.level, h.text);
  }
  return [1, 2, 3]
    .map((l) => byLevel.get(l))
    .filter((t): t is string => t !== undefined)
    .join(SECTION_SEP);
}

/** Paragraph pieces (blank-line separated, fence blocks atomic) with offsets. */
function scanPieces(text: string, start: number, end: number): Piece[] {
  const pieces: Piece[] = [];
  const scanner = new FenceScanner();
  let current: string[] = [];
  let currentStart = start;

  const flush = () => {
    const joined = current.join("\n");
    const trimmed = joined.trim();
    if (trimmed) {
      // Keep the offset of the first non-whitespace char (header-path
      // resolution at chunk start relies on exact offsets).
      pieces.push({ text: trimmed, offset: currentStart + (joined.length - joined.trimStart().length) });
    }
    current = [];
  };

  let lineStart = start;
  for (const line of text.slice(start, end).split("\n")) {
    const marker = scanner.feed(line);
    if (marker === "open") {
      flush();
      current = [line];
      currentStart = lineStart;
    } else if (marker === "close") {
      current.push(line);
      flush();
    } else if (scanner.inFence) {
      if (!current.length) currentStart = lineStart;
      current.push(line);
    } else if (line.trim() === "") {
      flush();
    } else {
      if (!current.length) currentStart = lineStart;
      current.push(line);
    }
    lineStart += line.length + 1;
  }
  flush();
  return pieces;
}

/* ------------------------------------------------------------------ */
/* Fixed assembly (budget-driven, overlap, oversized fallback)         */
/* ------------------------------------------------------------------ */

const SENTENCE_ENDERS = new Set([".", "!", "?", "…"]);
const CLOSERS = "\"»)]";
const TABLE_SEP_RE = /^\s{0,3}\|[\s:|-]*\|?\s*$/;

/** A maximal run of table rows (consecutive `|`-lines) with its header block. */
interface TableRun {
  start: number; // offset of the first row line
  end: number; // offset just past the last row line
  header: string; // header row (+ separator row when present)
  headerTokens: number;
}

/** Cust-fix 29.09: split table parts must start with the шапка, so every part
 *  of a table reads on its own (решение Кости — «резать таблицы умно»). */
function tableRuns(text: string): TableRun[] {
  const runs: TableRun[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let cur: { start: number; lines: string[]; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const header =
      cur.lines.length >= 2 && TABLE_SEP_RE.test(cur.lines[1])
        ? cur.lines[0] + "\n" + cur.lines[1]
        : cur.lines[0];
    runs.push({ start: cur.start, end: cur.end, header, headerTokens: estimateTokens(header) });
    cur = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      if (!cur) cur = { start: offset, lines: [line], end: offset + line.length };
      else {
        cur.lines.push(line);
        cur.end = offset + line.length;
      }
    } else flush();
    offset += line.length + 1;
  }
  flush();
  return runs;
}

function splitOversized(piece: Piece): Slot[] {
  // Legal cut points, one pass over lines (cust-fix 29.09, D-8 amendment):
  //  - end of a complete table row (tables have no sentences — the only legal
  //    cut inside a table is between rows; a ". " inside a cell is NOT one);
  //  - end of a complete list item (same logic for lists);
  //  - sentence end (ender + closers, then space/newline) on prose lines only.
  const bounds: number[] = [];
  let lineStart = 0;
  for (const line of piece.text.split("\n")) {
    const trimmed = line.trim();
    const lineEnd = lineStart + line.length; // offset of the "\n" (or EOF)
    const isRow = trimmed.startsWith("|");
    const isListItem = LIST_ITEM_RE.test(line);
    if (isRow) {
      if (lineEnd < piece.text.length) bounds.push(lineEnd + 1); // after the row's newline
    } else {
      if (isListItem && lineEnd < piece.text.length) bounds.push(lineEnd + 1);
      for (let i = lineStart; i < lineEnd; i++) {
        if (!SENTENCE_ENDERS.has(piece.text[i])) continue;
        let j = i + 1;
        while (j < piece.text.length && CLOSERS.includes(piece.text[j])) j++;
        if (j >= piece.text.length || piece.text[j] === " " || piece.text[j] === "\n") {
          bounds.push(j);
          i = j - 1;
        }
      }
    }
    lineStart += line.length + 1;
  }
  bounds.sort((a, b) => a - b);

  const runs = tableRuns(piece.text);

  const slots: Slot[] = [];
  let from = 0;
  let warned = false;
  const push = (to: number) => {
    const slice = piece.text.slice(from, to);
    const trimmed = slice.trim();
    if (trimmed) {
      let text = trimmed;
      // A part that starts mid-table repeats the шапка (header + separator),
      // so every part of the table reads on its own (решение Кости 29.09).
      const nl = piece.text.indexOf("\n", from);
      const firstLine = piece.text.slice(from, nl === -1 ? piece.text.length : nl).trim();
      const run = runs.find((r) => from > r.start && from < r.end);
      if (run && firstLine.startsWith("|")) text = run.header + "\n" + text;
      slots.push({ text, start: piece.offset + from + slice.indexOf(trimmed) });
      if (estimateTokens(text) > CHUNK_TOKEN_BUDGET && !warned) {
        // Last-resort insurance (a single sentence/row over budget): truncation
        // will trim it at embed time — surface it in the build log.
        console.warn(`[rag/chunking] chunk over token budget after hard cut (@${piece.offset})`);
        warned = true;
      }
    }
    from = to;
  };

  while (from < piece.text.length) {
    while (from < piece.text.length && /\s/.test(piece.text[from])) from++;
    if (from >= piece.text.length) break;
    // Pack up to the budget: the FARTHEST boundary that still fits (cust-fix
    // 29.09) — one-bound-per-slot shattered tables into single-row chunks.
    // A part that continues a table carries its шапка — reserve its tokens.
    const fromRun = runs.find((r) => from > r.start && from < r.end);
    let best = -1;
    for (const b of bounds) {
      if (b <= from) continue;
      const extra = fromRun && b < fromRun.end ? fromRun.headerTokens : 0;
      if (estimateTokens(piece.text.slice(from, b)) + extra > CHUNK_TOKEN_BUDGET) break;
      best = b;
    }
    if (best !== -1) {
      push(best);
      continue;
    }
    // No usable boundary (or a single oversized sentence/row): hard char cut.
    let to = from + 1;
    while (
      to < piece.text.length &&
      to - from < HARD_CHAR_CAP &&
      estimateTokens(piece.text.slice(from, to)) <= CHUNK_TOKEN_BUDGET
    ) {
      to++;
    }
    push(to);
  }
  return slots;
}

function assembleFixed(pieces: Piece[], source: string): Slot[] {
  const slots: Slot[] = [];
  let bucket: Piece[] = [];

  const bucketText = (list: Piece[]) => list.map((p) => p.text).join("\n\n");
  const flush = () => {
    if (!bucket.length) return;
    slots.push({ text: bucketText(bucket), start: bucket[0].offset });
    bucket = [];
  };

  for (const piece of pieces) {
    if (estimateTokens(piece.text) > CHUNK_TOKEN_BUDGET) {
      // Oversized single paragraph (big fence/table): sentence → hard cut.
      flush();
      slots.push(...splitOversized(piece));
      continue;
    }
    if (bucket.length && estimateTokens(bucketText([...bucket, piece])) > CHUNK_TOKEN_BUDGET) {
      const flushed = bucket;
      flush();
      // 15% overlap: carry trailing pieces of the flushed chunk.
      const carry: Piece[] = [];
      for (let i = flushed.length - 1; i >= 0; i--) {
        const candidate = [flushed[i], ...carry];
        if (estimateTokens(bucketText(candidate)) > OVERLAP_TOKEN_BUDGET) break;
        carry.pop();
        carry.unshift(flushed[i]);
      }
      bucket = carry;
    }
    bucket.push(piece);
  }
  flush();
  void source;
  return slots;
}

/* ------------------------------------------------------------------ */
/* Structured strategy                                                 */
/* ------------------------------------------------------------------ */

interface Section {
  path: string;
  start: number;
  end: number;
}

function scanSections(text: string, headers: Header[]): Section[] {
  const sections: Section[] = headers.map((h, i) => ({
    path: headerPathAt(headers, h.offset),
    start: h.offset,
    end: i + 1 < headers.length ? headers[i + 1].offset : text.length,
  }));
  if (headers.length === 0 || headers[0].offset > 0) {
    sections.unshift({ path: "", start: 0, end: headers.length ? headers[0].offset : text.length });
  }
  return sections.filter((s) => s.end > s.start);
}

/** Merge tiny (<200 chars) sections into the previous sibling (or next). */
function mergeTinySections(sections: Section[], text: string): Section[] {
  const merged: Section[] = [];
  for (const section of sections) {
    const tiny = text.slice(section.start, section.end).trim().length < MERGE_MIN_CHARS;
    if (tiny && merged.length > 0) {
      merged[merged.length - 1].end = section.end;
      continue;
    }
    if (tiny && merged.length === 0) {
      // No previous sibling yet: keep and let the next section absorb it.
      merged.push({ ...section });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && prev.path === "" && prev.end === section.start && text.slice(prev.start, prev.end).trim().length < MERGE_MIN_CHARS) {
      // Absorb a leading tiny preamble into the first real section.
      prev.end = section.end;
      prev.path = section.path;
      continue;
    }
    merged.push({ ...section });
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function toDrafts(file: CorpusFile, strategy: RagStrategy, slots: Slot[], sectionOf: (start: number) => string): ChunkDraft[] {
  return slots.map((slot, position) => ({
    chunk_id: `${strategy}:${file.source}:${position}`,
    source: file.source,
    file: file.file,
    title: file.title,
    section: sectionOf(slot.start),
    position,
    text: slot.text,
  }));
}

export function chunkFile(file: CorpusFile, strategy: RagStrategy): ChunkDraft[] {
  const headers = scanHeaders(file.text);
  if (strategy === "fixed") {
    const pieces = scanPieces(file.text, 0, file.text.length);
    const slots = assembleFixed(pieces, file.source);
    return toDrafts(file, strategy, slots, (start) => headerPathAt(headers, start));
  }

  const sections = mergeTinySections(scanSections(file.text, headers), file.text);
  const drafts: ChunkDraft[] = [];
  for (const section of sections) {
    const pieces = scanPieces(file.text, section.start, section.end);
    const slots = assembleFixed(pieces, file.source);
    let first = true;
    for (const slot of slots) {
      // Cust-fix 29.09 (решение Кости — structured должен конкурировать):
      // continuation chunks carry the section anchor, otherwise a packed
      // continuation loses the topic in the embedding (probes atlas/context
      // regressed without it — chunks themselves were unchanged).
      const anchor = !first && section.path ? `[${section.path}]\n` : "";
      first = false;
      drafts.push({
        chunk_id: "", // filled below with the running per-file index
        source: file.source,
        file: file.file,
        title: file.title,
        section: section.path,
        position: drafts.length,
        text: anchor + slot.text,
      });
    }
  }
  return drafts.map((d, position) => ({ ...d, chunk_id: `structured:${file.source}:${position}` }));
}

/* ---------------- Boundary quality metrics (cust-fix 29.09) --------------- */
/* The day21 metric counted ANY chunk not ending on .!?… as "inside a
 * sentence" — including chunks that end on a complete list item or table row
 * (clean block boundaries). Split into two honest metrics:
 *  - endsInsideBlock: cut did NOT land on a block boundary (sentence end,
 *    complete table row, list item, fence, heading) — the loose one;
 *  - endsInsideSentence: the last line is prose without a sentence
 *    terminator — a real mid-sentence cut (the strict, small one). */

const LIST_LINE_RE = LIST_ITEM_RE;
const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s/;
/** Thematic break (---, ***, ___) — a section separator, a clean block end. */
const HR_LINE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

function lastLineOf(text: string): string {
  const t = text.trimEnd();
  const i = t.lastIndexOf("\n");
  return i === -1 ? t : t.slice(i + 1);
}

function endsWithSentence(text: string): boolean {
  return /[.!?…]["»)\]]*\s*$/.test(text.trimEnd());
}

/** Cut did not land on a block boundary (sentence / table row / list item / fence / heading / hr / lead-in colon). */
export function endsInsideBlock(text: string): boolean {
  const rawLast = lastLineOf(text);
  const line = rawLast.trim();
  if (line.startsWith("|") && line.endsWith("|")) return false;
  if (LIST_LINE_RE.test(rawLast)) return false;
  if (HEADING_LINE_RE.test(rawLast)) return false;
  if (HR_LINE_RE.test(line)) return false;
  if (text.trimEnd().endsWith("```")) return false;
  return !endsWithSentence(text);
}

/** Real mid-sentence cut: prose last line without a sentence/lead-in terminator. */
export function endsInsideSentence(text: string): boolean {
  const rawLast = lastLineOf(text);
  const line = rawLast.trim();
  if (line.startsWith("|") && line.endsWith("|")) return false;
  if (LIST_LINE_RE.test(rawLast)) return false;
  if (HEADING_LINE_RE.test(rawLast)) return false;
  if (HR_LINE_RE.test(line)) return false;
  if (text.trimEnd().endsWith("```")) return false;
  return !/[.!?…:;—]["»)\]]*\s*$/.test(text.trimEnd());
}
