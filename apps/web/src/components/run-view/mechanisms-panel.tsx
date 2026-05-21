"use client";
import { useState } from "react";
import type {
  Mechanism,
  MechanismDrop,
  MechanismDropReason,
  RepurposingCandidate,
} from "@/lib/types";

const GENE_PREVIEW = 10;
const PATHWAY_PREVIEW = 8;

const DROP_REASON_LABEL: Record<MechanismDropReason, string> = {
  inactive: "Inactive condition",
  unresolved: "No PrimeKG match",
  "not-picked": "LLM did not rank top-5",
};

export function MechanismsPanel({
  mechanisms,
  mechanismDrops,
  repurposingCandidates,
}: {
  mechanisms: Mechanism[];
  mechanismDrops: MechanismDrop[];
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
      {mechanismDrops.length > 0 && <DroppedConditions drops={mechanismDrops} />}
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

function DroppedConditions({ drops }: { drops: MechanismDrop[] }) {
  const [open, setOpen] = useState(false);
  // Group by reason so the user sees the categorical breakdown.
  const grouped = drops.reduce<Record<MechanismDropReason, MechanismDrop[]>>(
    (acc, d) => {
      (acc[d.reason] ??= []).push(d);
      return acc;
    },
    {} as Record<MechanismDropReason, MechanismDrop[]>,
  );
  // Stable display order — inactive first (most numerous, least interesting),
  // then unresolved (the audit-relevant ones), then not-picked.
  const orderedReasons: MechanismDropReason[] = [
    "inactive",
    "unresolved",
    "not-picked",
  ];

  return (
    <div className="mt-4" data-testid="mechanism-drops">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="text-xs text-neutral-500 hover:text-neutral-800 flex items-center gap-1"
        aria-expanded={open}
        data-testid="mechanism-drops-toggle"
      >
        <span className="font-mono">{open ? "▾" : "▸"}</span>
        <span>Dropped from mechanism extraction ({drops.length})</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded border border-neutral-200 bg-neutral-50 p-3">
          {orderedReasons.map((reason) => {
            const items = grouped[reason];
            if (!items?.length) return null;
            return (
              <div key={reason}>
                <div className="text-xs font-medium text-neutral-600 mb-1">
                  {DROP_REASON_LABEL[reason]} ({items.length})
                </div>
                <ul className="text-xs space-y-1">
                  {items.map((d, i) => (
                    <li
                      key={`${d.code}-${i}`}
                      className="flex items-baseline gap-2"
                      data-testid="mechanism-drop-row"
                    >
                      <span className="text-neutral-800">{d.display}</span>
                      <span className="font-mono text-neutral-400">
                        {d.code}
                      </span>
                      {d.detail && (
                        <span className="text-neutral-500 truncate" title={d.detail}>
                          — {d.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
