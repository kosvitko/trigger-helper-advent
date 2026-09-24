import { z } from "zod";

/**
 * Day19: PubMed E-utilities client — moved here from scheduler.ts (day18)
 * so the pipeline `search` tool can reuse it without coupling to the
 * scheduler store. Pure functions, no state; server builds every URL
 * (no external URLs accepted); anonymous tier ~3 req/s — no retries by
 * design (design D-3).
 */

export const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
export const FETCH_TIMEOUT_MS = 10_000;

async function eutilsJson(url: URL): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`eutils ${res.status} at ${url.pathname}`);
  }
  return (await res.json()) as unknown;
}

const ESearchSchema = z.object({
  esearchresult: z.object({
    count: z.string(),
    idlist: z.array(z.string()),
  }),
});

export async function esearch(
  term: string,
  opts: { retmax: number; reldateDays?: number; retstart?: number },
): Promise<{ count: number; pmids: string[] }> {
  const url = new URL(`${EUTILS_BASE}/esearch.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", term);
  url.searchParams.set("retmode", "json");
  url.searchParams.set("retmax", String(opts.retmax));
  url.searchParams.set("sort", "pub date");
  if (opts.retstart !== undefined) {
    url.searchParams.set("retstart", String(opts.retstart));
  }
  if (opts.reldateDays) {
    url.searchParams.set("datetype", "edat");
    url.searchParams.set("reldate", String(opts.reldateDays));
  }
  const parsed = ESearchSchema.parse(await eutilsJson(url));
  return {
    count: Number(parsed.esearchresult.count) || 0,
    pmids: parsed.esearchresult.idlist,
  };
}

const ESummaryDocSchema = z.object({
  title: z.string().default(""),
  fulljournalname: z.string().default(""),
  pubdate: z.string().default(""),
  epubdate: z.string().default(""),
  authors: z.array(z.object({ name: z.string() })).default([]),
});

export type ArticleMeta = {
  title: string;
  journal: string;
  pubdate: string;
  epubdate: string;
  authors: string[];
};

export async function esummary(pmids: string[]): Promise<Map<string, ArticleMeta>> {
  const url = new URL(`${EUTILS_BASE}/esummary.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "json");
  const raw = (await eutilsJson(url)) as {
    result?: Record<string, unknown>;
  };
  const map = new Map<string, ArticleMeta>();
  const result = raw.result ?? {};
  for (const pmid of pmids) {
    const doc = ESummaryDocSchema.safeParse(result[pmid]);
    if (!doc.success) continue;
    map.set(pmid, {
      title: doc.data.title,
      journal: doc.data.fulljournalname || doc.data.pubdate,
      pubdate: doc.data.pubdate,
      epubdate: doc.data.epubdate,
      authors: doc.data.authors.slice(0, 3).map((a) => a.name),
    });
  }
  return map;
}

/** Plain-text abstract (retmode=text) — no XML parsing needed (design §5.2). */
export async function efetchAbstract(pmid: string): Promise<string> {
  const url = new URL(`${EUTILS_BASE}/efetch.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmid);
  url.searchParams.set("rettype", "abstract");
  url.searchParams.set("retmode", "text");
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`eutils ${res.status} at efetch`);
  }
  return res.text();
}
