/**
 * # search-trials
 *
 * Dual-channel trial discovery from ClinicalTrials.gov. The graph runs
 * this node after both upstream feeders complete:
 *
 *   - search-strategy channel: one CT.gov call per
 *     `state.searchStrategy.queries[i]` (`query.term=<query>`).
 *   - repurposing channel: one CT.gov call per
 *     `state.repurposingCandidates[i].drug.name`
 *     (`query.intr=<drug.name>`), bounded concurrency = 10.
 *
 * Both channels carry the same `state.searchStrategy.filters`. Results
 * are unioned and deduped by `nctId`. Each candidate is annotated with
 * provenance:
 *
 *   - `discoveredVia: ('strategy'|'repurposing')[]` — at least one entry.
 *   - `repurposingDrugIds: string[]` — the `drug.id` of each repurposing
 *     candidate whose intervention search surfaced this trial. Empty for
 *     strategy-only hits.
 *
 * ## Concurrency
 *
 * Strategy channel: parallel via `Promise.allSettled` (max 4 calls).
 * Repurposing channel: bounded via `mapWithConcurrency(..., 10, ...)`.
 * Combined: max 14 in-flight CT.gov calls per patient run.
 *
 * ## Error model
 *
 *   - No `searchStrategy` → `{error}`.
 *   - Single CT.gov call fails → warn-log, drop that call's contribution.
 *   - Both channels' Promise.allSettled rejected entirely → `{error}`.
 *   - Either channel produces ≥1 hit → success; partial loss tolerated.
 *   - No repurposing candidates → repurposing channel returns `[]`
 *     cleanly; strategy channel still runs.
 */

import type {
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import { searchClinicalTrials } from "../tools/clinicaltrials.js";
import type { AgentStateType } from "../state.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { errorMessage } from "../util/error.js";

const REPURPOSING_CONCURRENCY = 10;

type StrategyHit = { candidate: TrialCandidate; channel: "strategy" };
type RepurposingHit = {
  candidate: TrialCandidate;
  channel: "repurposing";
  drugId: string;
};

type ChannelResult = {
  hits: StrategyHit[] | RepurposingHit[];
  /** true when every CT.gov call in this channel failed */
  allFailed: boolean;
};

export async function searchTrials(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const strategy = state.searchStrategy;
  if (!strategy) {
    return { error: "No search strategy available" };
  }

  const [strategyResult, repurposingResult] = await Promise.allSettled([
    runStrategyChannel(strategy),
    runRepurposingChannel(strategy, state.repurposingCandidates),
  ]);

  const strategyChannel = unwrapOrWarn(strategyResult, "strategy");
  const repurposingChannel = unwrapOrWarn(repurposingResult, "repurposing");

  const strategyHits = strategyChannel.hits as StrategyHit[];
  const repurposingHits = repurposingChannel.hits as RepurposingHit[];

  if (
    strategyChannel.allFailed &&
    repurposingChannel.allFailed &&
    strategyHits.length === 0 &&
    repurposingHits.length === 0
  ) {
    return { error: "Failed to query CT.gov: both channels errored" };
  }

  return { candidates: unionAndDedupe(strategyHits, repurposingHits) };
}

async function runStrategyChannel(
  strategy: SearchStrategy,
): Promise<ChannelResult> {
  const settled = await Promise.allSettled(
    strategy.queries.map((q) =>
      searchClinicalTrials({ term: q, filters: strategy.filters }),
    ),
  );
  const hits: StrategyHit[] = [];
  let failCount = 0;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      for (const c of r.value) hits.push({ candidate: c, channel: "strategy" });
    } else {
      failCount++;
      console.warn(
        `search-trials: strategy query "${strategy.queries[i]}" failed: ${errorMessage(r.reason)}`,
      );
    }
  }
  return { hits, allFailed: settled.length > 0 && failCount === settled.length };
}

async function runRepurposingChannel(
  strategy: SearchStrategy,
  candidates: RepurposingCandidate[],
): Promise<ChannelResult> {
  if (candidates.length === 0) return { hits: [], allFailed: false };
  let failCount = 0;
  const results = await mapWithConcurrency(
    candidates,
    REPURPOSING_CONCURRENCY,
    async (rc): Promise<RepurposingHit[]> => {
      try {
        const trials = await searchClinicalTrials({
          intervention: rc.drug.name,
          filters: strategy.filters,
        });
        return trials.map((t) => ({
          candidate: t,
          channel: "repurposing" as const,
          drugId: rc.drug.id,
        }));
      } catch (err) {
        failCount++;
        console.warn(
          `search-trials: repurposing query "${rc.drug.name}" failed: ${errorMessage(err)}`,
        );
        return [];
      }
    },
  );
  return {
    hits: results.flat(),
    allFailed: candidates.length > 0 && failCount === candidates.length,
  };
}

function unwrapOrWarn(
  result: PromiseSettledResult<ChannelResult>,
  label: string,
): ChannelResult {
  if (result.status === "fulfilled") return result.value;
  console.warn(`search-trials: ${label} channel rejected: ${errorMessage(result.reason)}`);
  return { hits: [], allFailed: true };
}

function unionAndDedupe(
  strategyHits: StrategyHit[],
  repurposingHits: RepurposingHit[],
): TrialCandidate[] {
  const byNctId = new Map<string, TrialCandidate>();
  for (const { candidate } of strategyHits) {
    if (byNctId.has(candidate.nctId)) continue;
    byNctId.set(candidate.nctId, {
      ...candidate,
      discoveredVia: ["strategy"],
      repurposingDrugIds: [],
    });
  }
  for (const { candidate, drugId } of repurposingHits) {
    const existing = byNctId.get(candidate.nctId);
    if (existing) {
      if (!existing.discoveredVia.includes("repurposing")) {
        existing.discoveredVia.push("repurposing");
      }
      if (!existing.repurposingDrugIds.includes(drugId)) {
        existing.repurposingDrugIds.push(drugId);
      }
    } else {
      byNctId.set(candidate.nctId, {
        ...candidate,
        discoveredVia: ["repurposing"],
        repurposingDrugIds: [drugId],
      });
    }
  }
  return [...byNctId.values()];
}
