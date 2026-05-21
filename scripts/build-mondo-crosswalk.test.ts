/* eslint-disable no-console */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { buildCrosswalk } from "./build-mondo-crosswalk.js";

// ---------------------------------------------------------------------------
// Synthetic SSSOM TSV fixture
// ---------------------------------------------------------------------------
// Columns: subject_id, subject_label, predicate_id, object_id, object_label, mapping_justification
const SSSOM_HEADER =
  "subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification";

const SSSOM_ROWS = [
  // 1. exactMatch to SCTID for MONDO:0008019 (IS in nodes — single MONDO row, node_index 27165)
  "MONDO:0008019\tmullerian aplasia\tskos:exactMatch\tSCTID:237896008\t\tsemapv:ManualMappingCuration",
  // 2. closeMatch to SCTID for MONDO:0011043 (IS in nodes — single MONDO row, node_index 27166)
  "MONDO:0011043\tmyelodysplasia\tskos:closeMatch\tSCTID:190828005\t\tsemapv:ManualMappingCuration",
  // 3. broadMatch to SCTID — should be DROPPED (predicate not kept)
  "MONDO:0008019\tmullerian aplasia\tskos:broadMatch\tSCTID:999999001\t\tsemapv:ManualMappingCuration",
  // 4. exactMatch to non-SCTID object — should be DROPPED
  "MONDO:0008019\tmullerian aplasia\tskos:exactMatch\tDOID:12345\t\tsemapv:ManualMappingCuration",
  // 5. exactMatch to SCTID for MONDO:0099999 — NOT in nodes, should be SKIPPED
  "MONDO:0099999\tunknown disease\tskos:exactMatch\tSCTID:111111111\t\tsemapv:ManualMappingCuration",
  // 6a. Same SNOMED code collision: closeMatch first — MONDO:0013924 (grouped, node_index 27158)
  "MONDO:0013924\tosteogenesis imperfecta sub\tskos:closeMatch\tSCTID:866866001\t\tsemapv:ManualMappingCuration",
  // 6b. Same SNOMED code collision: exactMatch second — MONDO:0012592 (also grouped to node_index 27158)
  //     The exactMatch should WIN over the closeMatch even though it comes second in file order.
  "MONDO:0012592\tosteogenesis imperfecta sub2\tskos:exactMatch\tSCTID:866866001\t\tsemapv:ManualMappingCuration",
];

function makeSssomStream(rows: string[]): Readable {
  const content =
    "# SSSOM metadata comment\n" +
    "# another comment\n" +
    SSSOM_HEADER +
    "\n" +
    rows.join("\n") +
    "\n";
  return Readable.from([content]);
}

// ---------------------------------------------------------------------------
// Synthetic nodes CSV fixture (TAB-separated, header row first)
// ---------------------------------------------------------------------------
// Columns: node_index  node_id  node_type  node_name  node_source
const NODES_ROWS = [
  "node_index\tnode_id\tnode_type\tnode_name\tnode_source",
  // gene/protein row — should be ignored (not disease)
  "100\t1234\tgene/protein\tSOMEGENE\tNCBI",
  // single MONDO disease — MONDO numeric id 8019
  "27165\t8019\tdisease\tmullerian aplasia and hyperandrogenism\tMONDO",
  // single MONDO disease — MONDO numeric id 11043
  "27166\t11043\tdisease\tmyelodysplasia combo\tMONDO",
  // grouped MONDO disease — contains ids 13924 and 12592 (and others)
  "27158\t13924_12592_14672_13460\tdisease\tosteogenesis imperfecta\tMONDO_grouped",
];

function makeNodesStream(rows: string[]): Readable {
  return Readable.from([rows.join("\n") + "\n"]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("buildCrosswalk", () => {
  it("includes exactMatch SCTID entries that are in PrimeKG nodes", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });

    expect(result["237896008"]).toBeDefined();
    expect(result["237896008"]!.mondoId).toBe("MONDO:0008019");
    expect(result["237896008"]!.primekgNodeId).toBe("27165");
    expect(result["237896008"]!.primekgName).toBe(
      "mullerian aplasia and hyperandrogenism",
    );
  });

  it("includes closeMatch SCTID entries that are in PrimeKG nodes", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });

    expect(result["190828005"]).toBeDefined();
    expect(result["190828005"]!.mondoId).toBe("MONDO:0011043");
    expect(result["190828005"]!.primekgNodeId).toBe("27166");
  });

  it("drops broadMatch rows", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // SCTID:999999001 comes only from a broadMatch — must not appear
    expect(result["999999001"]).toBeUndefined();
  });

  it("drops non-SCTID object_id rows", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // DOID:12345 — object is not SCTID
    const hasNonSctid = Object.values(result).some(
      (v) => v.mondoId === "MONDO:0008019" && v.primekgNodeId === "27165",
    );
    // the valid SCTID mapping for MONDO:0008019 IS there, but no DOID key
    expect(Object.keys(result).every((k) => /^\d+$/.test(k))).toBe(true);
  });

  it("skips MONDO ids not present in nodes CSV", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // MONDO:0099999 not in nodes → SCTID:111111111 should not appear
    expect(result["111111111"]).toBeUndefined();
  });

  it("prefers exactMatch over closeMatch for same SNOMED code (collision policy)", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // SCTID:866866001 — closeMatch arrives first, exactMatch arrives second
    // exactMatch should win
    expect(result["866866001"]).toBeDefined();
    expect(result["866866001"]!.mondoId).toBe("MONDO:0012592");
  });

  it("resolves grouped MONDO node_id members to the same PrimeKG node", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // Both MONDO:0013924 and MONDO:0012592 are members of node_index 27158
    // The winning entry (exactMatch, MONDO:0012592) should resolve to 27158
    expect(result["866866001"]!.primekgNodeId).toBe("27158");
    expect(result["866866001"]!.primekgName).toBe("osteogenesis imperfecta");
  });

  it("ignores non-disease rows in nodes CSV", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // gene/protein node_index 100 should never appear as a primekgNodeId
    const hasGeneNode = Object.values(result).some(
      (v) => v.primekgNodeId === "100",
    );
    expect(hasGeneNode).toBe(false);
  });

  it("returns only the expected number of distinct SNOMED codes", async () => {
    const result = await buildCrosswalk({
      sssomStream: makeSssomStream(SSSOM_ROWS),
      nodesCsvStream: makeNodesStream(NODES_ROWS),
    });
    // expected codes: 237896008, 190828005, 866866001 → 3
    expect(Object.keys(result).length).toBe(3);
  });
});
