"use client";
import type { Mechanism, RepurposingCandidate } from "@/lib/types";

export function MechanismsPanel({
  mechanisms,
  repurposingCandidates,
}: {
  mechanisms: Mechanism[];
  repurposingCandidates: RepurposingCandidate[];
}) {
  // TODO: render mechanisms (genes/pathways per condition) and repurposing candidates.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">
        Mechanisms ({mechanisms.length}) · Repurposing ({repurposingCandidates.length})
      </h3>
      <p className="text-sm text-neutral-500">
        KG-derived mechanism findings will appear here.
      </p>
    </section>
  );
}
