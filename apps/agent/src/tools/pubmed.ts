import type { Citation } from "@clinical-trial-matching/shared";

export async function searchPubMed(
  _query: string,
  _maxResults = 10,
): Promise<Citation[]> {
  // TODO: GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?... + efetch
  throw new Error("searchPubMed not implemented");
}
