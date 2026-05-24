/**
 * # literature-support (trial-eval subgraph)
 *
 * PubMed citation lookup for a trial-patient match. Two-attempt loop
 * (bounded by `decide-if-more-evidence`): attempt 0 includes the
 * mechanism keyword; attempt 1 drops it to broaden. Citations are merged
 * with prior attempts (dedupe by pmid) so the broaden never reduces the
 * citation set.
 *
 * After each search we enrich citations with abstract excerpts via
 * `fetchAbstracts`. Both the PubMed search and the abstract fetch
 * soft-fail: a network error logs a warning and keeps the prior state.
 *
 * Counter-evidence is no longer a PubMed concern — it comes from
 * structured biomedical signals in `gather-counter-evidence`. See
 * docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md.
 *
 * No LLM call in this node. Pure PubMed retrieval; mechanism-plausibility
 * and synthesize-match consume the citation list.
 */

import type { Citation } from "@clinical-trial-matching/shared";

import { fetchAbstracts, searchPubMed } from "../../../tools/pubmed.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;
const SUPPORTING_MAX_RESULTS = 10;

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const supportingQuery = buildSupportingQuery(state);
  const supportingResult = await safeSearch(supportingQuery, SUPPORTING_MAX_RESULTS, "supporting");

  let supporting = state.literatureSupport;
  if (supportingResult) {
    const enriched = await enrichWithAbstracts(supportingResult);
    supporting = mergeByPmid(state.literatureSupport, enriched);
  }

  return {
    literatureSupport: supporting,
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}

async function safeSearch(
  query: string,
  max: number,
  label: string,
): Promise<Citation[] | null> {
  try {
    return await searchPubMed(query, max);
  } catch (err) {
    console.warn(
      `literature-support (${label}): searchPubMed failed: ${errorMessage(err)}`,
    );
    return null;
  }
}

async function enrichWithAbstracts(cits: Citation[]): Promise<Citation[]> {
  if (cits.length === 0) return cits;
  try {
    const abstractMap = await fetchAbstracts(cits.map((c) => c.pmid));
    return cits.map((c) => {
      const abs = abstractMap.get(c.pmid);
      return abs ? { ...c, abstractExcerpt: abs } : c;
    });
  } catch (err) {
    console.warn(`literature-support: fetchAbstracts failed: ${errorMessage(err)}`);
    return cits;
  }
}

function buildSupportingQuery(state: TrialEvalStateType): string {
  const drugs = state.candidate.interventions
    .slice(0, MAX_INTERVENTIONS_IN_QUERY)
    .map((d) => `"${d}"`)
    .join(" OR ");
  const condition =
    state.mechanisms[0]?.conditionName ??
    state.patientProfile.conditions[0]?.display ??
    "";
  const mechanismKw =
    state.evidenceAttempts === 0
      ? state.mechanisms[0]?.pathways[0]?.name ??
        state.mechanisms[0]?.geneTargets[0]?.name ??
        ""
      : "";

  const parts: string[] = [];
  if (drugs) parts.push(`(${drugs})`);
  if (condition) parts.push(`"${condition}"`);
  if (mechanismKw) parts.push(`"${mechanismKw}"`);
  return parts.join(" AND ");
}

function mergeByPmid(prior: Citation[], fresh: Citation[]): Citation[] {
  const byPmid = new Map<string, Citation>();
  for (const c of prior) byPmid.set(c.pmid, c);
  for (const c of fresh) if (!byPmid.has(c.pmid)) byPmid.set(c.pmid, c);
  return [...byPmid.values()];
}
