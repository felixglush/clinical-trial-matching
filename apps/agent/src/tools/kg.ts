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
