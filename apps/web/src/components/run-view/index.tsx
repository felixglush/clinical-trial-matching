"use client";
import { useEffect, useState } from "react";
import type {
  Mechanism,
  MechanismDrop,
  RepurposingCandidate,
  TrialCandidate,
  TrialMatch,
} from "@/lib/types";

import { GraphTimeline } from "./graph-timeline";
import { ReasoningTrace } from "./reasoning-trace";
import { MechanismsPanel } from "./mechanisms-panel";
import { CandidatesPanel } from "./candidates-panel";

type RunState = {
  mechanisms: Mechanism[];
  mechanismDrops: MechanismDrop[];
  repurposingCandidates: RepurposingCandidate[];
  candidates: TrialCandidate[];
  matches: TrialMatch[];
  error: string | null;
  activeNode: string | null;
};

export function RunView({ threadId }: { threadId: string }) {
  const [state, setState] = useState<RunState>({
    mechanisms: [],
    mechanismDrops: [],
    repurposingCandidates: [],
    candidates: [],
    matches: [],
    error: null,
    activeNode: null,
  });

  useEffect(() => {
    if (!threadId) return;
    const es = new EventSource(`/api/runs/${threadId}/stream`);

    es.onmessage = (e) => {
      // LangGraph SDK chunks come through as JSON-serialized
      // { event: string, data: object }. The SSE route forwards them on the
      // default channel.
      try {
        const chunk = JSON.parse(e.data) as { event?: string; data?: unknown };
        if (!chunk?.event) return;

        if (chunk.event === "values") {
          // Full state snapshot. We pull only the fields we render.
          const d = chunk.data as Partial<RunState> | null;
          if (!d) return;
          setState((prev) => ({
            ...prev,
            mechanisms: d.mechanisms ?? prev.mechanisms,
            mechanismDrops: d.mechanismDrops ?? prev.mechanismDrops,
            repurposingCandidates: d.repurposingCandidates ?? prev.repurposingCandidates,
            candidates: d.candidates ?? prev.candidates,
            matches: d.matches ?? prev.matches,
            error: d.error ?? prev.error,
          }));
        } else if (chunk.event === "updates") {
          // A node finished and is yielding its partial state. The data shape
          // is { [nodeName]: partialState }. Use the node name to drive the
          // GraphTimeline highlight.
          const d = chunk.data as Record<string, unknown> | null;
          if (!d) return;
          const node = Object.keys(d)[0];
          if (node) setState((prev) => ({ ...prev, activeNode: node }));
        }
      } catch {
        // Ignore parse errors — keep the stream open.
      }
    };

    es.addEventListener("error", (ev) => {
      // The stream is intentionally short-lived: the server closes it once
      // the run finishes. A close with readyState === 2 is normal end-of-run.
      const target = ev.currentTarget as EventSource | null;
      if (target && target.readyState === EventSource.CLOSED) {
        es.close();
      }
    });

    return () => es.close();
  }, [threadId]);

  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      <GraphTimeline activeNode={state.activeNode} />
      <div className="space-y-6">
        {state.error && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {state.error}
          </div>
        )}
        <MechanismsPanel
          mechanisms={state.mechanisms}
          mechanismDrops={state.mechanismDrops}
          repurposingCandidates={state.repurposingCandidates}
        />
        <ReasoningTrace messages={[]} />
        <CandidatesPanel candidates={state.candidates} matches={state.matches} />
      </div>
    </div>
  );
}
