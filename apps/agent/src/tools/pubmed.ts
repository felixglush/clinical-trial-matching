/**
 * # tools/pubmed
 *
 * NCBI E-utilities client for PubMed citation lookup. Two-step:
 *
 *   1. `esearch.fcgi?db=pubmed&term=<q>&retmax=<n>&retmode=json`
 *      → `{ esearchresult: { idlist: string[] } }`.
 *   2. `esummary.fcgi?db=pubmed&id=<csv>&retmode=json`
 *      → `{ result: { uids: string[], <pmid>: { title, pubdate, pubtype, articleids, ... } } }`.
 *
 * Abstracts are fetched on demand via `fetchAbstracts(pmids)`, which calls
 * `efetch.fcgi?...&rettype=abstract&retmode=text` and parses the plain-text
 * response into a `Map<pmid, abstract>` (truncated to 500 chars per entry).
 * Records without a parseable abstract body (editorials, letters) are skipped.
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
const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const PUBMED_BASE = "https://pubmed.ncbi.nlm.nih.gov";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 503]);
const ABSTRACT_MAX_CHARS = 500;

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

export async function fetchAbstracts(
  pmids: string[],
): Promise<Map<string, string>> {
  if (pmids.length === 0) return new Map();
  const url = appendApiKey(
    `${EFETCH_URL}?db=pubmed&id=${pmids.join(",")}&rettype=abstract&retmode=text`,
  );
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PubMed efetch ${res.status} for ${url}`);
  const text = await res.text();
  return parseAbstracts(text);
}

// PubMed efetch text format: records separated by blank lines; each record
// ends with "PMID: <num>". Abstract body is the run of paragraphs between
// the author information block and the PMID footer. This is a best-effort
// regex parse — return what we can find; skip records with no abstract.
function parseAbstracts(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // Split on lines like "1. ", "2. ", etc., which mark the start of each record.
  const records = text.split(/\n(?=\d+\. )/);
  for (const rec of records) {
    const pmidMatch = /\nPMID:\s*(\d+)\b/.exec(rec);
    if (!pmidMatch) continue;
    const pmid = pmidMatch[1]!;
    // Heuristic: take everything between the line after "Author information:"
    // ends (an empty line) and the "PMID:" / "Copyright" / "DOI:" footer.
    // Falls back to text between the title and PMID if no author block.
    const lines = rec.split("\n");
    const pmidLineIdx = lines.findIndex((l) => /^PMID:\s*\d+/.test(l));
    if (pmidLineIdx < 0) continue;
    // Find start: after the author/affiliation block. The line immediately
    // after a block of lines starting with "(" or "Author information:" /
    // capitalized name lists. Simplest heuristic: find the first blank line
    // AFTER any line that starts with "Author information:".
    let start = -1;
    let inAuthorBlock = false;
    for (let i = 0; i < pmidLineIdx; i++) {
      const ln = lines[i]!;
      if (/^Author information:/.test(ln)) inAuthorBlock = true;
      if (inAuthorBlock && ln.trim() === "") {
        start = i + 1;
        break;
      }
    }
    if (start < 0) continue; // no author block → no reliable abstract boundary
    // End at the PMID line, also stopping at Copyright/DOI/©.
    let end = pmidLineIdx;
    for (let i = start; i < pmidLineIdx; i++) {
      const ln = lines[i]!;
      if (/^(Copyright|©|DOI:)/i.test(ln)) {
        end = i;
        break;
      }
    }
    const abstract = lines.slice(start, end).join("\n").trim();
    if (!abstract) continue;
    map.set(pmid, abstract.slice(0, ABSTRACT_MAX_CHARS));
  }
  return map;
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
