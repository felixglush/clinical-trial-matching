#!/usr/bin/env tsx
/* eslint-disable no-console */
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

// PrimeKG raw CSVs on Harvard Dataverse. Update DOIs if Harvard moves files.
const NODES_URL =
  "https://dataverse.harvard.edu/api/access/datafile/6180617";
const EDGES_URL =
  "https://dataverse.harvard.edu/api/access/datafile/6180616";

const KEPT_NODE_TYPES = new Set([
  "drug",
  "disease",
  "gene/protein",
  "biological_process",
]);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "data/kg/raw");
const OUT_DIR = path.join(REPO_ROOT, "data/kg");

async function download(url: string, destPath: string) {
  if (existsSync(destPath)) {
    console.log(`exists, skipping: ${destPath}`);
    return;
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await finished(
    Readable.fromWeb(res.body as never).pipe(createWriteStream(destPath)),
  );
}

// PrimeKG distributes nodes.csv as TAB-separated with quoted string fields,
// and edges.csv as comma-separated with no quoting. Strip surrounding quotes
// from node fields so values can be compared as plain strings.
const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1");

async function filterNodes(srcPath: string, destPath: string): Promise<Set<string>> {
  const keptIds = new Set<string>();
  const out = createWriteStream(destPath);
  const rl = createInterface({ input: createReadStream(srcPath) });
  let header: string[] | null = null;
  let typeIdx = -1;
  let idIdx = -1;
  for await (const line of rl) {
    const cols = line.split("\t").map(unquote);
    if (!header) {
      header = cols;
      typeIdx = header.indexOf("node_type");
      idIdx = header.indexOf("node_index");
      if (typeIdx === -1 || idIdx === -1) {
        throw new Error(`nodes.csv header missing node_type or node_index: ${cols.join(" | ")}`);
      }
      out.write(cols.join("\t") + "\n");
      continue;
    }
    if (KEPT_NODE_TYPES.has(cols[typeIdx]!)) {
      keptIds.add(cols[idIdx]!);
      out.write(cols.join("\t") + "\n");
    }
  }
  out.end();
  await finished(out);
  console.log(`kept ${keptIds.size} nodes`);
  if (keptIds.size === 0) {
    throw new Error("filter produced no nodes — KEPT_NODE_TYPES likely does not match PrimeKG values");
  }
  return keptIds;
}

async function filterEdges(srcPath: string, destPath: string, keptIds: Set<string>) {
  const out = createWriteStream(destPath);
  const rl = createInterface({ input: createReadStream(srcPath) });
  let header: string[] | null = null;
  let srcIdx = -1;
  let dstIdx = -1;
  let count = 0;
  for await (const line of rl) {
    const cols = line.split(",");
    if (!header) {
      header = cols;
      srcIdx = header.indexOf("x_index");
      dstIdx = header.indexOf("y_index");
      if (srcIdx === -1 || dstIdx === -1) {
        throw new Error(`edges.csv header missing x_index or y_index: ${cols.join(" | ")}`);
      }
      out.write(line + "\n");
      continue;
    }
    if (keptIds.has(cols[srcIdx]!) && keptIds.has(cols[dstIdx]!)) {
      out.write(line + "\n");
      count++;
    }
  }
  out.end();
  await finished(out);
  console.log(`kept ${count} edges`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const rawNodes = path.join(RAW_DIR, "nodes.csv");
  const rawEdges = path.join(RAW_DIR, "edges.csv");
  await download(NODES_URL, rawNodes);
  await download(EDGES_URL, rawEdges);

  const outNodes = path.join(OUT_DIR, "nodes.csv");
  const outEdges = path.join(OUT_DIR, "edges.csv");
  const keptIds = await filterNodes(rawNodes, outNodes);
  await filterEdges(rawEdges, outEdges, keptIds);

  console.log(`done. filtered CSVs in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
