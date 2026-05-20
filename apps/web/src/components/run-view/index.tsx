"use client";
import { GraphTimeline } from "./graph-timeline";
import { ReasoningTrace } from "./reasoning-trace";
import { MechanismsPanel } from "./mechanisms-panel";
import { CandidatesPanel } from "./candidates-panel";

export function RunView({ threadId: _threadId }: { threadId: string }) {
  // TODO: open SSE stream to /api/runs/[threadId]/stream;
  // dispatch updates/values/messages to child panels.
  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      <GraphTimeline activeNode={null} />
      <div className="space-y-6">
        <MechanismsPanel mechanisms={[]} repurposingCandidates={[]} />
        <ReasoningTrace messages={[]} />
        <CandidatesPanel candidates={[]} matches={[]} />
      </div>
    </div>
  );
}
