import neo4j, { type Driver } from "neo4j-driver";
import type {
  KGNode,
  KGPath,
  Mechanism,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const username = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !username || !password) {
    throw new Error("NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD must be set");
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  return driver;
}

export async function pingKG(): Promise<boolean> {
  const session = getDriver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await session.run("RETURN 1");
    return true;
  } finally {
    await session.close();
  }
}

export async function findGeneTargetsForDisease(
  _diseaseId: string,
): Promise<KGNode[]> {
  // TODO: Cypher MATCH (d:Disease {id:$id})-[:disease_protein]->(g:GeneProtein) RETURN g
  throw new Error("findGeneTargetsForDisease not implemented");
}

export async function findSharedPathways(
  _diseaseId: string,
  _depth: number,
): Promise<KGNode[]> {
  throw new Error("findSharedPathways not implemented");
}

export async function findDrugsTargetingPathways(
  _pathwayIds: string[],
): Promise<RepurposingCandidate[]> {
  throw new Error("findDrugsTargetingPathways not implemented");
}

export async function pathBetween(
  _fromId: string,
  _toId: string,
  _maxHops: number,
): Promise<KGPath[]> {
  throw new Error("pathBetween not implemented");
}

export async function buildMechanismsForConditions(
  _conditionIds: string[],
): Promise<Mechanism[]> {
  // TODO: orchestrates findGeneTargets + findSharedPathways into Mechanism[]
  throw new Error("buildMechanismsForConditions not implemented");
}
