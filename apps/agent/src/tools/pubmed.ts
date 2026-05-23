/**
 * # tools/pubmed
 *
 * NCBI E-utilities client for PubMed citation lookup. Two-step:
 *
 *   1. `esearch.fcgi?db=pubmed&term=<q>&retmax=<n>&retmode=json`
 *      → `{ esearchresult: { idlist: string[] } }`.
 *   2. `esummary.fcgi?db=pubmed&id=<csv>&retmode=json`
 *      → `{ result: { uids: string[], <pmid>: { title, pubdate, articleids, ... } } }`.
 *
 * No abstract retrieval in v1 (efetch returns XML and bloats responses).
 * `Citation.abstractExcerpt` stays undefined. Revisit if synthesize-match
 * starts writing "no abstract context" in summaries.
 *
 * ## Rate limits and retries
 *
 * PubMed allows 3 req/sec without an API key, 10 req/sec with one (set
 * `PUBMED_API_KEY` env). We retry 429/503 with exponential backoff
 * (3 attempts, 1s/2s/4s), honoring `Retry-After`. Mirrors
 * `tools/clinicaltrials.ts`'s strategy.
 */

import type { Citation } from "@clinical-trial-matching/shared";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const PUBMED_BASE = "https://pubmed.ncbi.nlm.nih.gov";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 503]);

type EsearchResponse = {
  esearchresult?: { idlist?: string[] };
};

type EsummaryEntry = {
  uid?: string;
  title?: string;
  pubdate?: string;
  pubtype?: string[];
  articleids?: Array<{ idtype?: string; value?: string }>;
};

type EsummaryResponse = {
  result?: { uids?: string[] } & Record<string, EsummaryEntry>;
};

export async function searchPubMed(
  query: string,
  maxResults = 10,
): Promise<Citation[]> {
  const pmids = await esearch(query, maxResults);
  if (pmids.length === 0) return [];
  return await esummary(pmids);
}

async function esearch(query: string, retmax: number): Promise<string[]> {
  const url = appendApiKey(
    `${ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json`,
  );
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PubMed esearch ${res.status} for ${url}`);
  const body = (await res.json()) as EsearchResponse;
  return body.esearchresult?.idlist ?? [];
}

async function esummary(pmids: string[]): Promise<Citation[]> {
  const url = appendApiKey(
    `${ESUMMARY_URL}?db=pubmed&id=${pmids.join(",")}&retmode=json`,
  );
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PubMed esummary ${res.status} for ${url}`);
  const body = (await res.json()) as EsummaryResponse;
  const result = body.result;
  if (!result) return [];

  // Preserve esearch's ranking by iterating `pmids`, not `result.uids`.
  const out: Citation[] = [];
  for (const pmid of pmids) {
    const entry = result[pmid];
    if (!entry || typeof entry !== "object") continue;
    out.push(toCitation(pmid, entry));
  }
  return out;
}

function toCitation(pmid: string, entry: EsummaryEntry): Citation {
  return {
    pmid,
    title: entry.title ?? "(no title)",
    year: parseYear(entry.pubdate),
    url: `${PUBMED_BASE}/${pmid}/`,
    pubtype: entry.pubtype ?? [],
  };
}

function parseYear(pubdate: string | undefined): number | undefined {
  if (!pubdate) return undefined;
  const m = /^\d{4}/.exec(pubdate);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function appendApiKey(url: string): string {
  const key = process.env.PUBMED_API_KEY;
  if (!key) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (!RETRYABLE_STATUSES.has(res.status)) return res;
    lastRes = res;
    if (attempt === MAX_RETRIES - 1) break;
    const wait =
      parseRetryAfter(res.headers.get("retry-after")) ??
      BASE_BACKOFF_MS * 2 ** attempt;
    console.warn(
      `pubmed: ${res.status} on ${url}, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(wait);
  }
  return lastRes!;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
