// PrimeKG (Neo4j) query helpers.
//
// Read docs/primekg-querying.md before adding new queries — it documents
// the gene/protein-with-a-slash node type, the undirected-edge
// `DISTINCT` requirement, the FLOAT/INT trap on LIMIT params, and the
// MONDO_grouped multi-id shape that the crosswalk depends on.

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type {
  KGEdge,
  KGNode,
  KGPath,
  Mechanism,
  SafetyConcern,
} from "@clinical-trial-matching/shared";

import { resolveSnomedCondition, type ResolvedDisease } from "./snomed-mondo.js";

// ---------- Driver ----------

let driverInstance: Driver | null = null;

function getDriver(): Driver {
  if (driverInstance) return driverInstance;
  const uri = process.env.NEO4J_URI;
  const username = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !username || !password) {
    throw new Error("NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD must be set");
  }
  driverInstance = neo4j.driver(uri, neo4j.auth.basic(username, password));
  return driverInstance;
}

// Test seam: kg-test code can substitute an in-memory driver.
export function setDriver(d: Driver | null): void {
  driverInstance = d;
}

export async function pingKG(): Promise<boolean> {
  const session = openSession();
  try {
    await session.run("RETURN 1");
    return true;
  } finally {
    await session.close();
  }
}

function openSession(): Session {
  return getDriver().session({ database: process.env.NEO4J_DATABASE });
}

// ---------- Type normalization ----------
//
// PrimeKG/Neo4j stores the gene/protein node type with a slash ("gene/protein")
// because the original CSV does. Our shared schema's KGNode.type enum uses an
// identifier-safe form ("gene_protein"). Normalize at the read boundary so the
// rest of the codebase doesn't have to know about this quirk.

const NODE_TYPE_FROM_KG: Record<string, KGNode["type"]> = {
  "gene/protein": "gene_protein",
  drug: "drug",
  disease: "disease",
  biological_process: "biological_process",
};

function normalizeNodeType(raw: string): KGNode["type"] {
  const t = NODE_TYPE_FROM_KG[raw];
  if (!t) throw new Error(`unknown PrimeKG node type: ${raw}`);
  return t;
}

// ---------- Queries used by identify-relevant-mechanisms ----------

const CYPHER_GENE_TARGETS = `
MATCH (d:Node {id: $diseaseId})-[:\`associated with\`]-(g:Node {type: 'gene/protein'})
RETURN DISTINCT g.id AS id, g.name AS name
ORDER BY g.name
` as const;

const CYPHER_PATHWAYS_FOR_DISEASE = `
MATCH (d:Node {id: $diseaseId})-[:\`associated with\`]-(g:Node {type: 'gene/protein'})
                                -[:\`interacts with\`]-(p:Node {type: 'biological_process'})
WITH p, collect(DISTINCT g.id) AS sharedGeneIds
WITH p, sharedGeneIds, size(sharedGeneIds) AS shared
ORDER BY shared DESC
LIMIT $pathwayLimit
RETURN p.id AS id, p.name AS name, sharedGeneIds
` as const;

// Wrapped in {Cypher INTEGER} for the limit param because neo4j-driver maps
// raw JS numbers to FLOAT; LIMIT requires INTEGER.

export async function findGeneTargetsForDisease(
  diseaseId: string,
): Promise<KGNode[]> {
  const session = openSession();
  try {
    const result = await session.run(CYPHER_GENE_TARGETS, { diseaseId });
    return result.records.map((r) => ({
      id: r.get("id") as string,
      name: r.get("name") as string,
      type: "gene_protein",
    }));
  } finally {
    await session.close();
  }
}

export type PathwayHit = {
  pathway: KGNode;
  sharedGeneIds: string[];
};

export async function findPathwaysForDisease(
  diseaseId: string,
  pathwayLimit: number,
): Promise<PathwayHit[]> {
  const session = openSession();
  try {
    const result = await session.run(CYPHER_PATHWAYS_FOR_DISEASE, {
      diseaseId,
      pathwayLimit: neo4j.int(pathwayLimit),
    });
    return result.records.map((r) => ({
      pathway: {
        id: r.get("id") as string,
        name: r.get("name") as string,
        type: "biological_process",
      },
      sharedGeneIds: r.get("sharedGeneIds") as string[],
    }));
  } finally {
    await session.close();
  }
}

// ---------- Candidate mechanism construction ----------
//
// CandidateMechanism is what we hand to the LLM ranking step; it's a Mechanism
// without `rationale`. The node fills in the rationale from the LLM output and
// only then does the object conform to MechanismSchema.

export type CandidateMechanism = Omit<Mechanism, "rationale">;

export type ConditionInput = {
  snomedCode: string;
  conditionDisplay: string;
};

const DEFAULT_PATHWAY_LIMIT = 15;
// Max number of disease→gene→pathway sample paths emitted per pathway. Two is
// enough to convey "we found this pathway via these genes" without bloating
// the Mechanism payload.
const SUPPORT_PATHS_PER_PATHWAY = 2;

export async function buildCandidateMechanisms(
  conditions: ConditionInput[],
  opts: { pathwayLimit?: number } = {},
): Promise<{ candidates: CandidateMechanism[]; unresolved: string[] }> {
  const pathwayLimit = opts.pathwayLimit ?? DEFAULT_PATHWAY_LIMIT;
  const resolved: Array<{ cond: ConditionInput; disease: ResolvedDisease }> = [];
  const unresolved: string[] = [];

  for (const cond of conditions) {
    const disease = resolveSnomedCondition(cond.snomedCode);
    if (disease) resolved.push({ cond, disease });
    else unresolved.push(cond.snomedCode);
  }

  const candidates = await Promise.all(
    resolved.map(async ({ cond, disease }) => {
      const [geneTargets, pathwayHits] = await Promise.all([
        findGeneTargetsForDisease(disease.primekgNodeId),
        findPathwaysForDisease(disease.primekgNodeId, pathwayLimit),
      ]);
      const pathways = pathwayHits.map((h) => h.pathway);
      const supportingPaths = buildSupportingPaths(
        disease,
        geneTargets,
        pathwayHits,
      );
      const mechanism: CandidateMechanism = {
        conditionId: cond.snomedCode,
        conditionName: cond.conditionDisplay,
        mondoId: disease.mondoId,
        geneTargets,
        pathways,
        supportingPaths,
      };
      return mechanism;
    }),
  );

  return { candidates, unresolved };
}

// Construct disease → gene → pathway sample paths from the already-queried
// gene targets and pathway hits. Uses geneTargets' name index so each
// generated edge carries readable node display.
function buildSupportingPaths(
  disease: ResolvedDisease,
  geneTargets: KGNode[],
  pathwayHits: PathwayHit[],
): KGPath[] {
  const geneById = new Map<string, KGNode>();
  for (const g of geneTargets) geneById.set(g.id, g);
  const diseaseNode: KGNode = {
    id: disease.primekgNodeId,
    name: disease.primekgName,
    type: "disease",
  };

  const paths: KGPath[] = [];
  for (const hit of pathwayHits) {
    const picked = hit.sharedGeneIds.slice(0, SUPPORT_PATHS_PER_PATHWAY);
    for (const geneId of picked) {
      const gene = geneById.get(geneId);
      if (!gene) continue;
      const edges: KGEdge[] = [
        {
          source: disease.primekgNodeId,
          target: geneId,
          relation: "associated with",
        },
        {
          source: geneId,
          target: hit.pathway.id,
          relation: "interacts with",
        },
      ];
      paths.push({ nodes: [diseaseNode, gene, hit.pathway], edges });
    }
  }
  return paths;
}

export { normalizeNodeType };

// ---------- pathBetween ----------
//
// Variable-hop sample paths between two PrimeKG nodes. `LIMIT $pathLimit`
// keeps the result bounded; `maxHops = 3` covers drug → gene → process →
// disease and the symmetric form. PrimeKG edges are undirected (per
// docs/primekg-querying.md) — the `*1..N` syntax matches both directions.
//
// `neo4j.int(...)` is required for the LIMIT param: the driver maps raw
// JS numbers to FLOAT and Cypher LIMIT rejects FLOAT.

const CYPHER_PATH_BETWEEN = `
MATCH p = (a:Node {id: $fromId})-[*1..$maxHops]-(b:Node {id: $toId})
RETURN p
LIMIT $pathLimit
` as const;

export async function pathBetween(
  fromId: string,
  toId: string,
  maxHops = 3,
  pathLimit = 5,
): Promise<KGPath[]> {
  const session = openSession();
  try {
    const result = await session.run(CYPHER_PATH_BETWEEN, {
      fromId,
      toId,
      maxHops: neo4j.int(maxHops),
      pathLimit: neo4j.int(pathLimit),
    });
    return result.records.map((r) => pathFromDriverPath(r.get("p")));
  } finally {
    await session.close();
  }
}

// neo4j-driver's Path object exposes `segments[]`; each segment carries
// {start, relationship, end}. We flatten to {nodes[], edges[]} for the
// shared KGPath shape; types normalize via NODE_TYPE_FROM_KG.
type DriverNode = { properties: { id: string; name: string; type: string } };
type DriverRel = { type: string };
type DriverSegment = { start: DriverNode; relationship: DriverRel; end: DriverNode };
type DriverPath = { segments: DriverSegment[] };

function pathFromDriverPath(p: DriverPath): KGPath {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  if (p.segments.length === 0) return { nodes, edges };
  nodes.push(driverNodeToKGNode(p.segments[0]!.start));
  for (const seg of p.segments) {
    nodes.push(driverNodeToKGNode(seg.end));
    edges.push({
      source: seg.start.properties.id,
      target: seg.end.properties.id,
      relation: seg.relationship.type,
    });
  }
  return { nodes, edges };
}

function driverNodeToKGNode(n: DriverNode): KGNode {
  return {
    id: n.properties.id,
    name: n.properties.name,
    type: normalizeNodeType(n.properties.type),
  };
}

// ---------- findContraindicationsForDrugs ----------
//
// Deterministic safety lookup for `eligibility-check`'s step 1. Returns
// rows for every (drug, disease) pair in the input that has a
// `contraindication` edge in PrimeKG. `DISTINCT` because the undirected
// match yields duplicate rows.
//
// `side_effect` is NOT in this query: the subset built by
// `pnpm kg:build-subset` drops side-effect nodes/edges. The single-element
// enum on `SafetyConcern.relation` documents this; the spec corrects the
// drug-eval v2 reference to `side_effect`.

const CYPHER_CONTRAINDICATIONS = `
MATCH (d:Node {type: 'drug'})-[:\`contraindication\`]-(c:Node {type: 'disease'})
WHERE d.id IN $drugIds AND c.id IN $diseaseIds
RETURN DISTINCT d.id AS drugId, d.name AS drugName,
                c.id AS conditionId, c.name AS conditionName
` as const;

export async function findContraindicationsForDrugs(
  drugIds: string[],
  diseaseIds: string[],
): Promise<SafetyConcern[]> {
  if (drugIds.length === 0 || diseaseIds.length === 0) return [];
  const session = openSession();
  try {
    const result = await session.run(CYPHER_CONTRAINDICATIONS, {
      drugIds,
      diseaseIds,
    });
    return result.records.map((r) => ({
      drugId: r.get("drugId") as string,
      drugName: r.get("drugName") as string,
      conditionId: r.get("conditionId") as string,
      conditionName: r.get("conditionName") as string,
      relation: "contraindication" as const,
    }));
  } finally {
    await session.close();
  }
}

// ---------- resolveDrugByName ----------
//
// Lowercased + formulation-stripped exact-match lookup over PrimeKG's
// ~8K drug nodes. The name index is loaded once on first call and cached
// for the lifetime of the process. Hardening target: RxNorm/DrugBank
// crosswalk for real-world salt forms, brand names, and combo arms (see
// spec Risks item 1).

let drugNameIndex: Map<string, KGNode> | null = null;

// Test seam: tests can install a fixture index without touching Neo4j.
export function setDrugNameIndexForTests(idx: Map<string, KGNode> | null): void {
  drugNameIndex = idx;
}

const CYPHER_ALL_DRUGS = `
MATCH (d:Node {type: 'drug'})
RETURN d.id AS id, d.name AS name
` as const;

async function ensureDrugNameIndex(): Promise<Map<string, KGNode>> {
  if (drugNameIndex) return drugNameIndex;
  const session = openSession();
  try {
    const result = await session.run(CYPHER_ALL_DRUGS);
    const idx = new Map<string, KGNode>();
    for (const r of result.records) {
      const id = r.get("id") as string;
      const name = r.get("name") as string;
      idx.set(normalizeDrugName(name), { id, name, type: "drug" });
    }
    drugNameIndex = idx;
    return idx;
  } finally {
    await session.close();
  }
}

// Strip trailing dose/formulation tokens from a free-form intervention
// string. CT.gov interventions look like "Osimertinib 80mg tablet" or
// "Tagrisso 80 mg"; we want them to land on the same key as the
// PrimeKG `name` field. Brittle by design — flagged as a hardening
// target (see spec Risks item 1).
const FORMULATION_TOKENS =
  /\s+\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g|iu|u)\b\s*(?:tablet|tablets|capsule|capsules|injection|injectable|solution|cream|ointment|suspension|syrup|gel|patch|spray|oral|iv|im)?\.?\s*$/i;

function normalizeDrugName(raw: string): string {
  return raw.toLowerCase().replace(FORMULATION_TOKENS, "").trim();
}

export async function resolveDrugByName(name: string): Promise<KGNode | null> {
  const idx = await ensureDrugNameIndex();
  return idx.get(normalizeDrugName(name)) ?? null;
}
