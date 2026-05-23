import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "neo4j-driver";

import {
  buildCandidateMechanisms,
  findGeneTargetsForDisease,
  findPathwaysForDisease,
  setDriver,
} from "./kg.js";

// ---- Mock driver ----

type RecordRow = Record<string, unknown>;
type Canned = { query: string; rows: RecordRow[] };

function makeRecord(row: RecordRow) {
  return { get: (k: string) => row[k] };
}

function makeMockDriver(canned: Canned[]): {
  driver: Driver;
  calls: Array<{ query: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  const session = {
    run: async (query: string, params?: Record<string, unknown>) => {
      calls.push({ query, params: params ?? {} });
      const match = canned.find((c) => query.includes(c.query));
      if (!match) {
        throw new Error(`unexpected query (no canned response): ${query.slice(0, 120)}`);
      }
      return { records: match.rows.map(makeRecord) };
    },
    close: async () => undefined,
  };
  const driver = {
    session: () => session,
    close: async () => undefined,
  } as unknown as Driver;
  return { driver, calls };
}

afterEach(() => setDriver(null));

// ---- findGeneTargetsForDisease ----

describe("findGeneTargetsForDisease", () => {
  it("returns gene targets with normalized gene_protein type", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "associated with",
        rows: [
          { id: "100", name: "BRCA1" },
          { id: "200", name: "TP53" },
        ],
      },
    ]);
    setDriver(driver);

    const genes = await findGeneTargetsForDisease("DISEASE-ID-1");
    expect(genes).toEqual([
      { id: "100", name: "BRCA1", type: "gene_protein" },
      { id: "200", name: "TP53", type: "gene_protein" },
    ]);
    // Verify the disease id was bound as a parameter.
    expect(calls[0]!.params.diseaseId).toBe("DISEASE-ID-1");
    // Verify deterministic ordering is requested.
    expect(calls[0]!.query).toContain("ORDER BY g.name");
    // Verify the type literal queried matches what PrimeKG stores
    // (`gene/protein`, with a slash). If this string drifts, the live Neo4j
    // query will silently return zero genes — that's a regression we want a
    // test to catch.
    expect(calls[0]!.query).toContain("gene/protein");
  });
});

// ---- findPathwaysForDisease ----

describe("findPathwaysForDisease", () => {
  it("returns pathways with sharedGeneIds and biological_process type", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "biological_process",
        rows: [
          { id: "P1", name: "DNA repair", sharedGeneIds: ["100", "200"] },
          { id: "P2", name: "apoptosis", sharedGeneIds: ["200"] },
        ],
      },
    ]);
    setDriver(driver);

    const hits = await findPathwaysForDisease("DISEASE-ID-1", 15);
    expect(hits).toEqual([
      {
        pathway: { id: "P1", name: "DNA repair", type: "biological_process" },
        sharedGeneIds: ["100", "200"],
      },
      {
        pathway: { id: "P2", name: "apoptosis", type: "biological_process" },
        sharedGeneIds: ["200"],
      },
    ]);
    expect(calls[0]!.params.diseaseId).toBe("DISEASE-ID-1");
    // pathwayLimit must be passed as a Cypher INTEGER (else LIMIT fails on a FLOAT).
    expect(calls[0]!.params.pathwayLimit).toBeDefined();
  });
});

// ---- buildCandidateMechanisms ----

// SNOMED codes used here are real entries in the committed crosswalk; their
// resolutions are checked separately in snomed-mondo.test.ts. We only need
// them to NOT be null here so buildCandidateMechanisms proceeds to the KG
// queries.
const RA_SNOMED = "69896004";          // → PrimeKG id 29078, rheumatoid arthritis
const T2DM_SNOMED = "44054006";        // → PrimeKG id 28208, type 2 diabetes mellitus
const UNRESOLVABLE_SNOMED = "9999999"; // not in the crosswalk

describe("buildCandidateMechanisms", () => {
  let queryCallCount = 0;

  beforeEach(() => {
    queryCallCount = 0;
  });

  function setupTwoConditionDriver() {
    const { driver } = makeMockDriver([
      // Both conditions will hit both queries; the canned responses cycle by
      // matching substrings of the queries. Because findPathways query has the
      // most specific substring ("biological_process"), it's matched first.
      // For findGenes, the substring "associated with" matches multiple
      // queries — use a more specific substring instead.
      {
        query: "RETURN DISTINCT g.id",
        rows: [
          { id: "G1", name: "GENE-A" },
          { id: "G2", name: "GENE-B" },
        ],
      },
      {
        query: "biological_process",
        rows: [
          { id: "P1", name: "pathway-1", sharedGeneIds: ["G1", "G2"] },
          { id: "P2", name: "pathway-2", sharedGeneIds: ["G1"] },
        ],
      },
    ]);
    return driver;
  }

  it("skips unresolvable conditions and reports them", async () => {
    setDriver(setupTwoConditionDriver());

    const { candidates, unresolved } = await buildCandidateMechanisms([
      { snomedCode: RA_SNOMED, conditionDisplay: "Rheumatoid arthritis" },
      { snomedCode: UNRESOLVABLE_SNOMED, conditionDisplay: "Bogus condition" },
    ]);

    expect(unresolved).toEqual([UNRESOLVABLE_SNOMED]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.conditionId).toBe(RA_SNOMED);
    expect(candidates[0]!.conditionName).toBe("Rheumatoid arthritis");
  });

  it("populates geneTargets, pathways from the KG queries", async () => {
    setDriver(setupTwoConditionDriver());
    const { candidates } = await buildCandidateMechanisms([
      { snomedCode: RA_SNOMED, conditionDisplay: "Rheumatoid arthritis" },
    ]);
    const m = candidates[0]!;
    expect(m.geneTargets).toEqual([
      { id: "G1", name: "GENE-A", type: "gene_protein" },
      { id: "G2", name: "GENE-B", type: "gene_protein" },
    ]);
    expect(m.pathways).toEqual([
      { id: "P1", name: "pathway-1", type: "biological_process" },
      { id: "P2", name: "pathway-2", type: "biological_process" },
    ]);
  });

  it("constructs supportingPaths as disease→gene→pathway triples", async () => {
    setDriver(setupTwoConditionDriver());
    const { candidates } = await buildCandidateMechanisms([
      { snomedCode: RA_SNOMED, conditionDisplay: "Rheumatoid arthritis" },
    ]);
    const m = candidates[0]!;
    // P1 has 2 shared genes (G1, G2) so 2 paths; P2 has 1 (G1) so 1 path.
    expect(m.supportingPaths).toHaveLength(3);

    const firstPath = m.supportingPaths[0]!;
    expect(firstPath.nodes.map((n) => n.type)).toEqual([
      "disease",
      "gene_protein",
      "biological_process",
    ]);
    // First node is the disease (resolved from the crosswalk).
    expect(firstPath.nodes[0]!.name).toBe("rheumatoid arthritis");
    // Edge relations match what we queried with.
    expect(firstPath.edges.map((e) => e.relation)).toEqual([
      "associated with",
      "interacts with",
    ]);
    // Edges connect correctly: disease→gene, then gene→pathway.
    expect(firstPath.edges[0]!.source).toBe(firstPath.nodes[0]!.id);
    expect(firstPath.edges[0]!.target).toBe(firstPath.nodes[1]!.id);
    expect(firstPath.edges[1]!.source).toBe(firstPath.nodes[1]!.id);
    expect(firstPath.edges[1]!.target).toBe(firstPath.nodes[2]!.id);
  });

  it("returns empty results when all conditions are unresolvable", async () => {
    // Driver shouldn't even be touched in this case — no canned responses
    // are needed. But we still set one in case implementation calls it.
    const { driver, calls } = makeMockDriver([]);
    setDriver(driver);

    const { candidates, unresolved } = await buildCandidateMechanisms([
      { snomedCode: UNRESOLVABLE_SNOMED, conditionDisplay: "Unknown" },
    ]);
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([UNRESOLVABLE_SNOMED]);
    expect(calls).toEqual([]);
  });

  it("processes multiple resolvable conditions concurrently", async () => {
    setDriver(setupTwoConditionDriver());
    queryCallCount;
    const { candidates, unresolved } = await buildCandidateMechanisms([
      { snomedCode: RA_SNOMED, conditionDisplay: "Rheumatoid arthritis" },
      { snomedCode: T2DM_SNOMED, conditionDisplay: "Type 2 DM" },
    ]);
    expect(unresolved).toEqual([]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.conditionId).sort()).toEqual(
      [RA_SNOMED, T2DM_SNOMED].sort(),
    );
  });
});

// ---- pathBetween ----

import {
  pathBetween,
  findContraindicationsForDrugs,
  resolveDrugByName,
  setDrugNameIndexForTests,
} from "./kg.js";

describe("pathBetween", () => {
  it("returns KGPath[] from variable-hop driver result", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "MATCH p = (a:Node",
        rows: [
          {
            p: {
              segments: [
                {
                  start: { properties: { id: "DB09330", name: "osimertinib", type: "drug" } },
                  relationship: { type: "target" },
                  end: { properties: { id: "EGFR", name: "EGFR", type: "gene/protein" } },
                },
                {
                  start: { properties: { id: "EGFR", name: "EGFR", type: "gene/protein" } },
                  relationship: { type: "associated with" },
                  end: { properties: { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" } },
                },
              ],
            },
          },
        ],
      },
    ]);
    setDriver(driver);
    const paths = await pathBetween("DB09330", "MONDO:0005233", 3, 5);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.nodes).toEqual([
      { id: "DB09330", name: "osimertinib", type: "drug" },
      { id: "EGFR", name: "EGFR", type: "gene_protein" },
      { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" },
    ]);
    expect(paths[0]!.edges).toEqual([
      { source: "DB09330", target: "EGFR", relation: "target" },
      { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
    ]);
    // Verify params are passed as integers via neo4j.int (LIMIT FLOAT trap).
    expect(calls[0]!.params.maxHops).toMatchObject({ low: 3 });
    expect(calls[0]!.params.pathLimit).toMatchObject({ low: 5 });
  });

  it("returns [] on no paths (no throw)", async () => {
    const { driver } = makeMockDriver([
      { query: "MATCH p = (a:Node", rows: [] },
    ]);
    setDriver(driver);
    const paths = await pathBetween("DB09330", "MONDO:9999999");
    expect(paths).toEqual([]);
  });
});

// ---- findContraindicationsForDrugs ----

describe("findContraindicationsForDrugs", () => {
  it("returns SafetyConcern[] keyed by drug × disease intersection", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "contraindication",
        rows: [
          {
            drugId: "DB00072",
            drugName: "trastuzumab",
            conditionId: "MONDO:0007254",
            conditionName: "breast cancer",
          },
        ],
      },
    ]);
    setDriver(driver);
    const concerns = await findContraindicationsForDrugs(
      ["DB00072", "DB00563"],
      ["MONDO:0007254", "MONDO:0008383"],
    );
    expect(concerns).toEqual([
      {
        drugId: "DB00072",
        drugName: "trastuzumab",
        conditionId: "MONDO:0007254",
        conditionName: "breast cancer",
        relation: "contraindication",
      },
    ]);
    expect(calls[0]!.params.drugIds).toEqual(["DB00072", "DB00563"]);
    expect(calls[0]!.params.diseaseIds).toEqual(["MONDO:0007254", "MONDO:0008383"]);
    // Verify the Cypher matches the verbatim relation name.
    expect(calls[0]!.query).toContain("contraindication");
  });

  it("returns [] on empty input (skips Cypher)", async () => {
    const { driver, calls } = makeMockDriver([]);
    setDriver(driver);
    expect(await findContraindicationsForDrugs([], ["MONDO:0007254"])).toEqual([]);
    expect(await findContraindicationsForDrugs(["DB00072"], [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---- resolveDrugByName ----

describe("resolveDrugByName", () => {
  afterEach(() => setDrugNameIndexForTests(null));

  it("looks up via the cached name index (no driver call after first warm)", async () => {
    setDrugNameIndexForTests(
      new Map([
        ["osimertinib", { id: "DB09330", name: "osimertinib", type: "drug" }],
        ["trastuzumab", { id: "DB00072", name: "trastuzumab", type: "drug" }],
      ]),
    );
    const out = await resolveDrugByName("Osimertinib");
    expect(out).toEqual({ id: "DB09330", name: "osimertinib", type: "drug" });
  });

  it("strips dose/formulation suffixes from the input", async () => {
    setDrugNameIndexForTests(
      new Map([["osimertinib", { id: "DB09330", name: "osimertinib", type: "drug" }]]),
    );
    expect(await resolveDrugByName("osimertinib 80mg tablet")).toMatchObject({ id: "DB09330" });
    expect(await resolveDrugByName("Osimertinib 80 mg")).toMatchObject({ id: "DB09330" });
  });

  it("returns null on miss", async () => {
    setDrugNameIndexForTests(new Map());
    expect(await resolveDrugByName("imaginarium")).toBeNull();
  });

  it("populates the index from Cypher on first call when empty", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "MATCH (d:Node {type: 'drug'})",
        rows: [
          { id: "DB00072", name: "trastuzumab" },
          { id: "DB09330", name: "Osimertinib" },
        ],
      },
    ]);
    setDriver(driver);
    setDrugNameIndexForTests(null); // force lazy-load
    const out = await resolveDrugByName("osimertinib");
    expect(out).toMatchObject({ id: "DB09330", name: "Osimertinib" });
    expect(calls).toHaveLength(1);
  });
});
