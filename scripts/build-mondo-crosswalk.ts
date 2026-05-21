#!/usr/bin/env tsx
/* eslint-disable no-console */
//
// Build a SNOMED CT → PrimeKG disease-node crosswalk.
//
// Inputs:
//   - MONDO SSSOM (cross-reference) TSV. Pulled from MONDO master branch on
//     2026-05-21. If you regenerate, pin to a specific MONDO release tag and
//     update this header.
//       https://raw.githubusercontent.com/monarch-initiative/mondo/master/src/ontology/mappings/mondo.sssom.tsv
//     Format: a YAML-like metadata header (lines starting with "#") followed
//     by a 6-col TSV: subject_id, subject_label, predicate_id, object_id,
//     object_label, mapping_justification.
//
//   - PrimeKG subset nodes.csv at data/kg/nodes.csv (produced by
//     pnpm kg:build-subset; do not regenerate here). TAB-separated:
//     node_index, node_id, node_type, node_name, node_source.
//
// Output:
//   apps/agent/src/data/snomed-to-primekg.json — { [snomedCode]: {
//     mondoId, primekgNodeId, primekgName } }.
//
// Why we ship the join artifact: the agent runs on LangGraph Platform and
// shouldn't redownload a 13MB SSSOM file at boot. The JSON is small (a few
// hundred KB) and gives the runtime a pure in-memory lookup.

import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import path from "node:path";

const SSSOM_URL =
  "https://raw.githubusercontent.com/monarch-initiative/mondo/master/src/ontology/mappings/mondo.sssom.tsv";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "data/kg/raw");
const NODES_CSV = path.join(REPO_ROOT, "data/kg/nodes.csv");
const SSSOM_TSV = path.join(RAW_DIR, "mondo.sssom.tsv");
const OUT_JSON = path.join(REPO_ROOT, "apps/agent/src/data/snomed-to-primekg.json");

// Predicates we keep. broadMatch / narrowMatch widen / narrow the concept and
// are too lossy for clinical-trial eligibility, so they're dropped.
const KEPT_PREDICATES = new Set(["skos:exactMatch", "skos:closeMatch"]);

const PREDICATE_RANK: Record<string, number> = {
  "skos:exactMatch": 2,
  "skos:closeMatch": 1,
};

export type CrosswalkEntry = {
  mondoId: string;
  primekgNodeId: string;
  primekgName: string;
};
export type Crosswalk = Record<string, CrosswalkEntry>;

type MondoIndex = Map<string, { primekgNodeId: string; primekgName: string }>;

// Strip leading zeros: "MONDO:0000001" → "1". Keep "0" as "0" (defensive,
// though MONDO never emits a zero numeric).
function stripLeadingZeros(s: string): string {
  return s.replace(/^0+/, "") || "0";
}

async function buildMondoIndex(nodesCsvStream: Readable): Promise<MondoIndex> {
  const index: MondoIndex = new Map();
  const rl = createInterface({ input: nodesCsvStream });
  let header: string[] | null = null;
  let idxNodeIndex = -1;
  let idxNodeId = -1;
  let idxNodeType = -1;
  let idxNodeName = -1;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      idxNodeIndex = header.indexOf("node_index");
      idxNodeId = header.indexOf("node_id");
      idxNodeType = header.indexOf("node_type");
      idxNodeName = header.indexOf("node_name");
      if (idxNodeIndex < 0 || idxNodeId < 0 || idxNodeType < 0 || idxNodeName < 0) {
        throw new Error(`nodes.csv missing expected columns: ${cols.join(" | ")}`);
      }
      continue;
    }
    if (cols[idxNodeType] !== "disease") continue;
    const primekgNodeId = cols[idxNodeIndex]!;
    const primekgName = cols[idxNodeName]!;
    const nodeId = cols[idxNodeId]!;
    // node_id is either a single MONDO numeric id ("5148") or, for
    // MONDO_grouped rows, underscore-joined member ids ("11123_12919_...").
    for (const member of nodeId.split("_")) {
      if (member) index.set(member, { primekgNodeId, primekgName });
    }
  }
  return index;
}

type Stats = {
  sssomRowsScanned: number;
  sctidRowsKept: number;
  mondoMatchedInPrimekg: number;
  collisionsResolved: number;
  finalEntries: number;
};

export async function buildCrosswalk(opts: {
  sssomStream: Readable;
  nodesCsvStream: Readable;
}): Promise<Crosswalk> {
  const { crosswalk } = await buildCrosswalkWithStats(opts);
  return crosswalk;
}

export async function buildCrosswalkWithStats(opts: {
  sssomStream: Readable;
  nodesCsvStream: Readable;
}): Promise<{ crosswalk: Crosswalk; stats: Stats }> {
  const mondoIndex = await buildMondoIndex(opts.nodesCsvStream);

  const crosswalk: Crosswalk = {};
  // Track predicate rank per SNOMED so a later exactMatch can overwrite an
  // earlier closeMatch. Ties (same predicate, different MONDO) keep the first.
  const winningRank = new Map<string, number>();

  const stats: Stats = {
    sssomRowsScanned: 0,
    sctidRowsKept: 0,
    mondoMatchedInPrimekg: 0,
    collisionsResolved: 0,
    finalEntries: 0,
  };

  const rl = createInterface({ input: opts.sssomStream });
  let header: string[] | null = null;
  let idxSubject = -1;
  let idxPredicate = -1;
  let idxObject = -1;

  for await (const rawLine of rl) {
    if (!rawLine) continue;
    if (rawLine.startsWith("#")) continue;
    if (!header) {
      header = rawLine.split("\t");
      idxSubject = header.indexOf("subject_id");
      idxPredicate = header.indexOf("predicate_id");
      idxObject = header.indexOf("object_id");
      if (idxSubject < 0 || idxPredicate < 0 || idxObject < 0) {
        throw new Error(`SSSOM header missing required columns: ${header.join(" | ")}`);
      }
      continue;
    }
    stats.sssomRowsScanned++;
    const cols = rawLine.split("\t");
    const objectId = cols[idxObject] ?? "";
    if (!objectId.startsWith("SCTID:")) continue;
    const predicate = cols[idxPredicate] ?? "";
    if (!KEPT_PREDICATES.has(predicate)) continue;
    stats.sctidRowsKept++;

    const subjectId = cols[idxSubject] ?? "";
    if (!subjectId.startsWith("MONDO:")) continue;
    const mondoNumeric = stripLeadingZeros(subjectId.slice("MONDO:".length));
    const primekgNode = mondoIndex.get(mondoNumeric);
    if (!primekgNode) continue;
    stats.mondoMatchedInPrimekg++;

    const snomedCode = objectId.slice("SCTID:".length);
    const rank = PREDICATE_RANK[predicate] ?? 0;
    const currentRank = winningRank.get(snomedCode);
    if (currentRank !== undefined) {
      stats.collisionsResolved++;
      // Strictly greater: prefer exactMatch over closeMatch. Ties keep first.
      if (rank <= currentRank) continue;
    }
    winningRank.set(snomedCode, rank);
    crosswalk[snomedCode] = {
      mondoId: subjectId,
      primekgNodeId: primekgNode.primekgNodeId,
      primekgName: primekgNode.primekgName,
    };
  }
  stats.finalEntries = Object.keys(crosswalk).length;
  return { crosswalk, stats };
}

async function download(url: string, destPath: string) {
  if (existsSync(destPath)) {
    console.log(`exists, skipping download: ${destPath}`);
    return;
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await finished(
    Readable.fromWeb(res.body as never).pipe(createWriteStream(destPath)),
  );
}

async function main() {
  if (!existsSync(NODES_CSV)) {
    throw new Error(
      `missing ${NODES_CSV}. Run 'pnpm kg:build-subset' first to produce the PrimeKG subset.`,
    );
  }
  await mkdir(RAW_DIR, { recursive: true });
  await download(SSSOM_URL, SSSOM_TSV);

  console.log("building crosswalk…");
  const { crosswalk, stats } = await buildCrosswalkWithStats({
    sssomStream: createReadStream(SSSOM_TSV),
    nodesCsvStream: createReadStream(NODES_CSV),
  });

  console.log("stats:");
  console.log(`  SSSOM data rows scanned:       ${stats.sssomRowsScanned}`);
  console.log(`  SCTID + kept-predicate rows:   ${stats.sctidRowsKept}`);
  console.log(`  MONDO matched in PrimeKG:      ${stats.mondoMatchedInPrimekg}`);
  console.log(`  collisions resolved:           ${stats.collisionsResolved}`);
  console.log(`  final entries:                 ${stats.finalEntries}`);

  if (stats.finalEntries === 0) {
    throw new Error("crosswalk produced 0 entries — input shapes likely changed");
  }

  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  // Sort keys so the committed JSON has stable diffs.
  const sorted: Crosswalk = {};
  for (const k of Object.keys(crosswalk).sort()) sorted[k] = crosswalk[k]!;
  await writeFile(OUT_JSON, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`wrote ${OUT_JSON}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
