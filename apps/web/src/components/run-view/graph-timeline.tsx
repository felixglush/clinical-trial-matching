"use client";

const NODES = [
  "extract-patient-profile",
  "identify-relevant-mechanisms",
  "find-repurposing-candidates",
  "generate-search-strategy",
  "search-trials",
  "pre-filter",
  "trial-eval-subgraph",
  "rank-and-synthesize",
  "human-approval",
] as const;

export function GraphTimeline({ activeNode }: { activeNode: string | null }) {
  return (
    <ol className="space-y-1 text-sm">
      {NODES.map((node) => (
        <li
          key={node}
          className={node === activeNode ? "font-semibold text-blue-600" : "text-neutral-600"}
        >
          {node}
        </li>
      ))}
    </ol>
  );
}
