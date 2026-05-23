/**
 * # literature-support (trial-eval subgraph)
 *
 * PubMed citation lookup for a trial-patient match. Two-attempt loop
 * (bounded by `decide-if-more-evidence`): attempt 0 includes the
 * mechanism keyword; attempt 1 drops it (broaden). Citations are merged
 * with prior attempts (dedupe by pmid) so the broaden never reduces the
 * citation set.
 *
 * No LLM call in this node. Pure PubMed retrieval; synthesize-match
 * consumes the citation list.
 */

import type { Citation } from "@clinical-trial-matching/shared";

import { searchPubMed } from "../../../tools/pubmed.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;
const MAX_RESULTS = 10;

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const query = buildQuery(state);
  let fetched: Citation[] = [];
  try {
    fetched = await searchPubMed(query, MAX_RESULTS);
  } catch (err) {
    console.warn(
      `literature-support: PubMed failed (${state.candidate.nctId}): ${errorMessage(err)} (keeping prior citations)`,
    );
    return {
      literatureSupport: state.literatureSupport,
      evidenceAttempts: state.evidenceAttempts + 1,
    };
  }

  return {
    literatureSupport: mergeByPmid(state.literatureSupport, fetched),
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}

function buildQuery(state: TrialEvalStateType): string {
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
