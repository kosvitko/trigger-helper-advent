import path from "node:path";
import type { Env } from "../../config/env.js";
import type { ToolSpec } from "../deepseek.js";
import { ragSourceLabel, type RagToolPayload } from "../agent/rag-tool.js";
import type { RagAskSource } from "./answer.js";
import { repoRoot } from "./paths.js";
import { createRagService, type RagChunk, type SearchHit } from "./store.js";

/**
 * Day33 (гейт 261014, Pick A): retrieve-only search over data/support-rag
 * structured index — пользовательский FAQ-корпус (клон project-search дня 31).
 */

export const SUPPORT_SEARCH_TOOL = "support_search";

const SUPPORT_K = 8;
const RENDER_CHAR_CAP = 4_000;
const SNIPPET_CHAR_CAP = 320;
const SNIPPET_COUNT = 5;

export type SupportSearcher = {
  search(query: string): Promise<{ chunks: RagChunk[]; sources: RagAskSource[]; topCosine: number | null }>;
};

function hitsToSources(hits: SearchHit[]): RagAskSource[] {
  return hits.map(({ chunk, score }) => ({
    chunk_id: chunk.chunk_id,
    score,
    source: chunk.source,
    file: chunk.file,
    title: chunk.title,
    section: chunk.section,
  }));
}

export function createSupportSearch(env: Env): SupportSearcher {
  const supportEnv: Env = {
    ...env,
    RAG_INDEX_DIR: path.join(repoRoot, "data/support-rag"),
  };
  const rag = createRagService(supportEnv);

  return {
    async search(query: string) {
      const q = query.trim();
      if (!q) return { chunks: [], sources: [], topCosine: null };
      const { hits } = await rag.search(q, "structured", SUPPORT_K);
      const topCosine = hits[0]?.score ?? null;
      if (topCosine != null) {
        console.log(`[support_search] topCosine=${topCosine.toFixed(4)} query=${JSON.stringify(q.slice(0, 80))}`);
      }
      return {
        chunks: hits.map((h) => h.chunk),
        sources: hitsToSources(hits),
        topCosine,
      };
    },
  };
}

export function buildSupportSearchToolSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: SUPPORT_SEARCH_TOOL,
      description:
        "Поиск по FAQ и пользовательской документации Trigger Helper (лимиты, тарифы, ошибки, приватность). " +
        "Вернёт фрагменты и источники [source › section] без LLM-ответа. " +
        "Запрос формулируй самодостаточно, на русском.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Вопрос о продукте: лимиты, тарифы, модели, ошибки, приватность, границы.",
          },
        },
        required: ["query"],
      },
    },
  };
}

export type SupportSearchToolPayload = Pick<
  RagToolPayload,
  "question" | "answer" | "quotes" | "sources" | "labels" | "dontKnow" | "topCosine" | "error"
>;

export type SupportSearchOutcome = {
  ok: boolean;
  content: string;
  payload: SupportSearchToolPayload;
};

function renderSupportSearch(payload: SupportSearchToolPayload): string {
  const lines: string[] = [
    `support_search · dontKnow=${payload.dontKnow ? "true" : "false"}` +
      (payload.topCosine != null ? ` · topCosine=${payload.topCosine.toFixed(4)}` : ""),
  ];
  if (payload.error) {
    lines.push(`ошибка: ${payload.error}`);
    return lines.slice(0, RENDER_CHAR_CAP).join("\n");
  }
  if (payload.sources.length === 0) {
    lines.push("Фрагментов не найдено.");
    return lines.join("\n");
  }
  lines.push("Фрагменты:");
  for (const q of payload.quotes.slice(0, SNIPPET_COUNT)) {
    lines.push(`- ${q.quote} — ${q.source} › ${q.section || "—"}`);
  }
  if (payload.labels.length > 0) {
    lines.push("Источники:");
    for (const label of payload.labels) lines.push(`- ${label}`);
  }
  const text = lines.join("\n");
  return text.length > RENDER_CHAR_CAP ? `${text.slice(0, RENDER_CHAR_CAP - 1)}…` : text;
}

export async function runSupportSearch(
  query: string,
  searcher: SupportSearcher,
): Promise<SupportSearchOutcome> {
  const question = query.trim();
  if (!question) {
    const payload: SupportSearchToolPayload = {
      question: "",
      answer: "",
      quotes: [],
      sources: [],
      labels: [],
      dontKnow: false,
      topCosine: null,
      error: "invalid_query",
    };
    return { ok: false, content: renderSupportSearch(payload), payload };
  }
  try {
    const { chunks, sources, topCosine } = await searcher.search(question);
    const quotes = chunks.slice(0, SNIPPET_COUNT).map((c) => {
      const snippet =
        c.text.length > SNIPPET_CHAR_CAP ? `${c.text.slice(0, SNIPPET_CHAR_CAP - 1)}…` : c.text;
      return {
        quote: snippet.replace(/\s+/g, " ").trim(),
        chunk_id: c.chunk_id,
        source: c.source,
        section: c.section,
      };
    });
    const payload: SupportSearchToolPayload = {
      question,
      answer: "",
      quotes,
      sources,
      labels: sources.map((s) => ragSourceLabel(s)),
      topCosine,
      dontKnow: false,
    };
    return { ok: true, content: renderSupportSearch(payload), payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload: SupportSearchToolPayload = {
      question,
      answer: "",
      quotes: [],
      sources: [],
      labels: [],
      dontKnow: false,
      topCosine: null,
      error: message,
    };
    return { ok: false, content: renderSupportSearch(payload), payload };
  }
}
