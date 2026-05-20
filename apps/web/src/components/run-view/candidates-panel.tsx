"use client";
import type { TrialCandidate, TrialMatch } from "@/lib/types";

export function CandidatesPanel({
  candidates,
  matches,
}: {
  candidates: TrialCandidate[];
  matches: TrialMatch[];
}) {
  // TODO: render candidates / matches as they update; surface
  // mechanism score and repurposing badge per match.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">
        Candidates ({candidates.length}) · Matches ({matches.length})
      </h3>
      <p className="text-sm text-neutral-500">Trials will appear here as they're evaluated.</p>
    </section>
  );
}
