"use client";
import type { Mechanism, RepurposingCandidate } from "@/lib/types";

const GENE_PREVIEW = 10;
const PATHWAY_PREVIEW = 8;

export function MechanismsPanel({
  mechanisms,
  repurposingCandidates,
}: {
  mechanisms: Mechanism[];
  repurposingCandidates: RepurposingCandidate[];
}) {
  return (
    <section data-testid="mechanisms-panel">
      <h3 className="text-sm font-semibold mb-2">
        Mechanisms ({mechanisms.length}) · Repurposing ({repurposingCandidates.length})
      </h3>
      {mechanisms.length === 0 ? (
        <p className="text-sm text-neutral-500">
          KG-derived mechanism findings will appear here.
        </p>
      ) : (
        <ol className="space-y-3" data-testid="mechanisms-list">
          {mechanisms.map((m, i) => (
            <MechanismCard key={`${m.conditionId}-${i}`} mechanism={m} index={i} />
          ))}
        </ol>
      )}
    </section>
  );
}

function MechanismCard({ mechanism, index }: { mechanism: Mechanism; index: number }) {
  return (
    <li
      className="rounded border border-neutral-200 bg-white p-3 text-sm"
      data-testid="mechanism-card"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-neutral-400">#{index + 1}</span>
        <span className="font-semibold">{mechanism.conditionName}</span>
        <span className="ml-auto font-mono text-xs text-neutral-400">
          SNOMED {mechanism.conditionId}
        </span>
      </div>
      <p className="mt-2 text-neutral-700" data-testid="mechanism-rationale">
        {mechanism.rationale}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <PreviewList
          label={`Gene targets (${mechanism.geneTargets.length})`}
          items={mechanism.geneTargets.slice(0, GENE_PREVIEW).map((g) => g.name)}
          totalCount={mechanism.geneTargets.length}
          previewCount={GENE_PREVIEW}
        />
        <PreviewList
          label={`Pathways (${mechanism.pathways.length})`}
          items={mechanism.pathways.slice(0, PATHWAY_PREVIEW).map((p) => p.name)}
          totalCount={mechanism.pathways.length}
          previewCount={PATHWAY_PREVIEW}
        />
      </div>
    </li>
  );
}

function PreviewList({
  label,
  items,
  totalCount,
  previewCount,
}: {
  label: string;
  items: string[];
  totalCount: number;
  previewCount: number;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-500 mb-1">{label}</div>
      {items.length === 0 ? (
        <div className="text-xs text-neutral-400">(none)</div>
      ) : (
        <ul className="text-xs text-neutral-800 space-y-0.5">
          {items.map((name) => (
            <li key={name} className="truncate" title={name}>
              {name}
            </li>
          ))}
          {totalCount > previewCount && (
            <li className="text-neutral-400">+ {totalCount - previewCount} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
