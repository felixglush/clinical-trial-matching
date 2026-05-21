#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * # scripts/build-txgnn-data
 *
 * Build the two committed JSON artifacts the agent runtime loads:
 *
 *   apps/agent/src/data/txgnn-predictions.json    — keyed by MONDO id
 *   apps/agent/src/data/txgnn-explanations.json   — keyed by `${mondoId}::${drugId}`
 *
 * Inputs (this revision — see docs/txgnn-distribution.md for context):
 *
 *   data/txgnn-curated/predictions.tsv     — hand-curated starter dataset for
 *                                             archetype-patient MONDOs. Real
 *                                             TxGNN bulk predictions are not
 *                                             publicly distributed; this
 *                                             curated set has the same shape.
 *   data/txgnn-curated/explanations.json   — companion explainer paths, also
 *                                             hand-curated. Most (disease,drug)
 *                                             pairs have no explanation; that's
 *                                             expected and the runtime handles
 *                                             missing paths gracefully.
 *
 * Filtering (defaults, tunable here in one place):
 *
 *   - drop rows where predIndication <= 0.5
 *   - drop rows where predContraindication >= predIndication
 *   - sort kept rows per disease by predIndication desc
 *   - cap top-50 per disease
 *   - normalize gene/protein -> gene_protein in explanation node types
 *
 * When real TxGNN output becomes available, point parsePredictionsDump and
 * parseExplanationsDump at the new format. filterAndShape is the contract
 * with the runtime — keep it stable.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PREDS_TSV = path.join(REPO_ROOT, "data/txgnn-curated/predictions.tsv");
const EXPLS_JSON = path.join(REPO_ROOT, "data/txgnn-curated/explanations.json");
const OUT_DIR = path.join(REPO_ROOT, "apps/agent/src/data");
const OUT_PREDS = path.join(OUT_DIR, "txgnn-predictions.json");
const OUT_EXPLS = path.join(OUT_DIR, "txgnn-explanations.json");

// Filter thresholds — drop predictions below INDICATION_THRESHOLD and any
// where contraindication dominates. Capped to TOP_K_PER_DISEASE rows after
// sort. Tune here if real TxGNN output proves noisier or sparser than the
// curated starter dataset.
const INDICATION_THRESHOLD = 0.5;
const TOP_K_PER_DISEASE = 50;

// Raw row after parsing the dump but before filter/shape. Stable contract
// with filterAndShape — adapters for different upstream formats normalize
// to this shape.
export type RawRow = {
  disease: string;       // MONDO id, e.g. "MONDO:0005148"
  drugId: string;
  drugName: string;
  pi: number;            // predIndication
  pc: number;            // predContraindication
};

export type RawExplanation = {
  nodes: { id: string; name: string; type: string }[];
  edges: { source: string; target: string; relation: string }[];
};

export type ShapedPrediction = {
  drugId: string;
  drugName: string;
  predIndication: number;
  predContraindication: number;
};

export type FilterAndShapeOptions = {
  topKPerDisease: number;
  rawExplanations?: Record<string, RawExplanation>;
};

export function filterAndShape(
  raw: RawRow[],
  opts: FilterAndShapeOptions,
): {
  predictions: Record<string, ShapedPrediction[]>;
  explanations: Record<string, RawExplanation>;
} {
  // Threshold filter — keep rows where indication is meaningful AND beats
  // the contraindication signal. See module docstring for rationale.
  const kept = raw.filter((r) => r.pi > INDICATION_THRESHOLD && r.pc < r.pi);

  // Group by disease, sort desc by pi, cap top-K.
  const byDisease = new Map<string, RawRow[]>();
  for (const r of kept) {
    const bucket = byDisease.get(r.disease) ?? [];
    bucket.push(r);
    byDisease.set(r.disease, bucket);
  }
  const predictions: Record<string, ShapedPrediction[]> = {};
  for (const [disease, rows] of byDisease) {
    rows.sort((a, b) => b.pi - a.pi);
    predictions[disease] = rows.slice(0, opts.topKPerDisease).map((r) => ({
      drugId: r.drugId,
      drugName: r.drugName,
      predIndication: r.pi,
      predContraindication: r.pc,
    }));
  }

  // Keep only explanations whose (disease, drug) pair survived the filter.
  // Normalize node types at this boundary so the runtime never sees the
  // PrimeKG raw "gene/protein" string.
  const keptPairs = new Set<string>();
  for (const [disease, preds] of Object.entries(predictions)) {
    for (const p of preds) keptPairs.add(`${disease}::${p.drugId}`);
  }
  const explanations: Record<string, RawExplanation> = {};
  for (const [key, expl] of Object.entries(opts.rawExplanations ?? {})) {
    if (!keptPairs.has(key)) continue;
    explanations[key] = {
      nodes: expl.nodes.map((n) => ({
        ...n,
        type: n.type === "gene/protein" ? "gene_protein" : n.type,
      })),
      edges: expl.edges,
    };
  }

  return { predictions, explanations };
}

// ─── Dump parsing ────────────────────────────────────────────────────────
//
// When swapping to real TxGNN output, replace these with the new format's
// parsers. The output shape (RawRow / RawExplanation) is the stable
// contract with filterAndShape.

async function parsePredictionsDump(dumpPath: string): Promise<RawRow[]> {
  if (!existsSync(dumpPath)) {
    throw new Error(
      `TxGNN curated predictions not found at ${dumpPath}. See docs/txgnn-distribution.md.`,
    );
  }
  const text = await readFile(dumpPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0]!.split("\t");
  const COL_NAMES = {
    disease: "disease_mondo",
    drugId: "drug_id",
    drugName: "drug_name",
    pi: "pred_indication",
    pc: "pred_contraindication",
  } as const;
  const idx = {
    disease: header.indexOf(COL_NAMES.disease),
    drugId: header.indexOf(COL_NAMES.drugId),
    drugName: header.indexOf(COL_NAMES.drugName),
    pi: header.indexOf(COL_NAMES.pi),
    pc: header.indexOf(COL_NAMES.pc),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) {
      const colName = COL_NAMES[k as keyof typeof COL_NAMES];
      throw new Error(
        `${dumpPath}: missing required column "${colName}". Found: ${header.join(" | ")}`,
      );
    }
  }
  const out: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split("\t");
    const pi = Number(cols[idx.pi]);
    const pc = Number(cols[idx.pc]);
    if (Number.isNaN(pi) || Number.isNaN(pc)) continue;
    out.push({
      disease: cols[idx.disease]!,
      drugId: cols[idx.drugId]!,
      drugName: cols[idx.drugName]!,
      pi,
      pc,
    });
  }
  return out;
}

async function parseExplanationsDump(
  dumpPath: string,
): Promise<Record<string, RawExplanation>> {
  if (!existsSync(dumpPath)) return {};
  const text = await readFile(dumpPath, "utf8");
  return JSON.parse(text) as Record<string, RawExplanation>;
}

// Sort object keys so committed artifacts have stable ordering — future
// regenerations against reordered inputs produce minimal diffs.
function sortedByKey<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k]!;
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Parsing predictions from ${PREDS_TSV}...`);
  const raw = await parsePredictionsDump(PREDS_TSV);
  console.log(`  ${raw.length} rows parsed`);

  console.log(`Parsing explanations from ${EXPLS_JSON}...`);
  const rawExpls = await parseExplanationsDump(EXPLS_JSON);
  console.log(`  ${Object.keys(rawExpls).length} pairs parsed`);

  console.log("Filtering and shaping...");
  const { predictions, explanations } = filterAndShape(raw, {
    topKPerDisease: TOP_K_PER_DISEASE,
    rawExplanations: rawExpls,
  });
  const totalPreds = Object.values(predictions).reduce((a, b) => a + b.length, 0);
  console.log(
    `  ${Object.keys(predictions).length} diseases, ${totalPreds} predictions, ${Object.keys(explanations).length} explanations kept`,
  );

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PREDS, JSON.stringify(sortedByKey(predictions), null, 2) + "\n");
  await writeFile(OUT_EXPLS, JSON.stringify(sortedByKey(explanations), null, 2) + "\n");
  console.log(`Wrote ${OUT_PREDS}`);
  console.log(`Wrote ${OUT_EXPLS}`);
}

// Only run main when this file is executed directly (not when imported by
// the test). Standard tsx idiom.
if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
