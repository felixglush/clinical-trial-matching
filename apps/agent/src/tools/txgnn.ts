/**
 * # tools/txgnn
 *
 * Pure in-memory lookup over the committed TxGNN prediction dump. The dump
 * is built by `pnpm kg:build-txgnn` (see scripts/build-txgnn-data.ts) and
 * lives at apps/agent/src/data/txgnn-{predictions,explanations}.json.
 *
 * ## Why a static dump rather than live inference
 *
 * TxGNN is a graph neural network that requires a CUDA GPU to score. The
 * Zitnik lab does not publicly distribute a bulk prediction table (see
 * docs/txgnn-distribution.md), so we either (a) generate one ourselves on a
 * cloud GPU and commit the output, or (b) hand-curate a starter set for
 * archetype patients. The current data file is the latter — clearly marked
 * as such — and the architecture is unchanged if the data is later replaced
 * with real TxGNN output.
 *
 * ## Schema (mirrors the JSONs)
 *
 *   predictions: { [mondoId]: TxGNNPrediction[] }   sorted by predIndication desc
 *   explanations: { [`${mondoId}::${drugId}`]: KGPath }
 *
 * ## Error behavior
 *
 * Per spec error model, missing or malformed data files are a build-time
 * bug and should be loud — but throwing at module-load time would crash the
 * agent at boot in dev (before the build script has been run). We instead
 * lazy-load at first use; the failure surfaces as a thrown Error that the
 * calling node (find-repurposing-candidates) catches and translates into a
 * `{error: "..."}` state.
 *
 * ## Test seam
 *
 * `__setFixturesForTests` is a test-only injection point. Tests call it at
 * module top level to bypass the loader entirely. The underscore marks it
 * as private API — production code never calls it.
 */

import type { KGPath } from "@clinical-trial-matching/shared";

export type TxGNNPrediction = {
  drugId: string;
  drugName: string;
  predIndication: number;
  predContraindication: number;
};

type PredictionsMap = Record<string, TxGNNPrediction[]>;
type ExplanationsMap = Record<string, KGPath>;

type LoadState =
  | { kind: "unloaded" }
  | { kind: "ready"; predictions: PredictionsMap; explanations: ExplanationsMap }
  | { kind: "error"; message: string };

let state: LoadState = { kind: "unloaded" };

async function ensureLoaded(): Promise<void> {
  if (state.kind !== "unloaded") return;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — data files are generated at build time by `pnpm kg:build-txgnn`
    const predMod = await import("../data/txgnn-predictions.json", {
      with: { type: "json" },
    });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — data files are generated at build time by `pnpm kg:build-txgnn`
    const explMod = await import("../data/txgnn-explanations.json", {
      with: { type: "json" },
    });
    state = {
      kind: "ready",
      predictions: (predMod.default ?? predMod) as PredictionsMap,
      explanations: (explMod.default ?? explMod) as ExplanationsMap,
    };
  } catch (err) {
    state = {
      kind: "error",
      message: `TxGNN data files missing or malformed (run \`pnpm kg:build-txgnn\`): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readyOrThrow(): {
  predictions: PredictionsMap;
  explanations: ExplanationsMap;
} {
  if (state.kind === "ready") return state;
  if (state.kind === "error") throw new Error(state.message);
  throw new Error(
    "tools/txgnn: ensureTxgnnLoaded() must be awaited before first lookup.",
  );
}

// Test-only injection point. Production code does not call this; tests do.
// Bypasses the import-based loader entirely.
export function __setFixturesForTests(
  preds: PredictionsMap,
  expls: ExplanationsMap,
): void {
  state = { kind: "ready", predictions: preds, explanations: expls };
}

// Called by the node before any sync lookup. Idempotent.
export async function ensureTxgnnLoaded(): Promise<void> {
  await ensureLoaded();
  // Throw early so the caller can convert to a node-level {error}.
  readyOrThrow();
}

export function lookupPredictions(
  mondoId: string,
  topN: number,
): TxGNNPrediction[] {
  const { predictions } = readyOrThrow();
  const all = predictions[mondoId];
  if (!all) return [];
  return all.slice(0, topN);
}

export function lookupExplanation(
  mondoId: string,
  drugId: string,
): KGPath | null {
  const { explanations } = readyOrThrow();
  return explanations[`${mondoId}::${drugId}`] ?? null;
}

export function isCovered(mondoId: string): boolean {
  const { predictions } = readyOrThrow();
  return predictions[mondoId] !== undefined && predictions[mondoId].length > 0;
}
