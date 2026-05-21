# PrimeKG querying notes

PrimeKG-in-Neo4j quirks that aren't obvious from the schema and will burn
you the first time. Read before writing new Cypher in
[`apps/agent/src/tools/kg.ts`](../apps/agent/src/tools/kg.ts) or
exploring the graph in the Neo4j Browser / via the
[`neo4j-mcp`](https://github.com/neo4j-contrib/mcp-neo4j) server.

Companion docs: [`kg-crosswalk.md`](kg-crosswalk.md) for SNOMED→MONDO
resolution, [`topology.md`](topology.md) for which agent nodes consume
which queries.

## Schema crib sheet

Every node has label `:Node` with properties `{id, type, name, source}`.
There is no per-type label — discriminate with `type`.

| `n.type` (literal string) | Count   | Note |
| ------------------------- | ------- | ---- |
| `biological_process`      | 28,642  | underscore; pathways, GO BP terms |
| `gene/protein`            | 27,671  | **slash** — see below |
| `disease`                 | 17,080  | `source` is `MONDO` or `MONDO_grouped` |
| `drug`                    | 7,957   | DrugBank ids |

Relationship types (12 total) preserve the original PrimeKG
`display_relation` verbatim, including spaces:

```
associated with    enzyme              parent-child
carrier            indication          ppi
contraindication   interacts with      synergistic interaction
off-label use      target              transporter
```

Backtick anything with a space or hyphen in Cypher:

```cypher
MATCH (d:Node {type: 'disease'})-[:`associated with`]-(g:Node)
```

## Gotcha 1: `gene/protein` has a slash

PrimeKG stores the gene/protein node type as the literal string
`gene/protein` (with a `/`) because the source CSV does. Our shared
`KGNode.type` enum uses `gene_protein` (identifier-safe). If you write
Cypher against the schema form, you get **zero rows back, silently**:

```cypher
-- WRONG — returns nothing
MATCH (g:Node {type: 'gene_protein'}) RETURN count(g)
-- → 0

-- RIGHT
MATCH (g:Node {type: 'gene/protein'}) RETURN count(g)
-- → 27671
```

Convention: query with the raw form, normalize at the read boundary
(`kg.ts::normalizeNodeType`). Don't propagate `gene/protein` outside of
`kg.ts`.

## Gotcha 2: edges are undirected (in meaning); duplicate rows on traversal

PrimeKG relationships are semantically symmetric ("disease X is
associated with gene Y" ≡ "gene Y is associated with disease X") but
were imported with arbitrary direction by APOC's
`create.relationship`. Don't write directional matches — they'll miss
half the edges depending on import order:

```cypher
-- WRONG — relies on import-time direction
MATCH (d:Node {id: $id})-[:`associated with`]->(g:Node {type: 'gene/protein'})

-- RIGHT
MATCH (d:Node {id: $id})-[:`associated with`]-(g:Node {type: 'gene/protein'})
```

Undirected matching has its own pitfall: each edge is traversed in both
directions, producing duplicate rows. Use `DISTINCT` (and / or
`collect(DISTINCT ...)`):

```cypher
MATCH (d:Node {id: $id})-[:`associated with`]-(g:Node {type: 'gene/protein'})
RETURN DISTINCT g.id AS id, g.name AS name
```

## Gotcha 3: `LIMIT` rejects FLOAT

`neo4j-driver` maps raw JS numbers to Cypher FLOAT. `LIMIT` (and `SKIP`)
require INTEGER. Pass numeric parameters through `neo4j.int(...)`:

```ts
import neo4j from "neo4j-driver";

await session.run(
  "MATCH (n) RETURN n LIMIT $limit",
  { limit: neo4j.int(15) },          // ← required
);
```

Symptom if you forget: `Neo.ClientError.Statement.TypeError: Type
mismatch: expected Integer but was Float`. Misleading the first time
because the literal `15` looks like an integer in your editor.

## Gotcha 4: `MONDO_grouped` disease nodes carry multiple MONDO ids

A single `:Node {type: 'disease', source: 'MONDO_grouped'}` row has
`node_id` like `"11123_12919_7454_5147_..."` — an underscore-joined list
of MONDO numeric ids that PrimeKG decided to roll up. If you're joining
external data keyed by MONDO id (e.g. our SNOMED crosswalk), you must
split this and emit an entry per member id pointing to the same
`primekgNodeId`. See the build step in
[`scripts/build-mondo-crosswalk.ts`](../scripts/build-mondo-crosswalk.ts).

## Gotcha 5: pathways aren't attached to diseases directly

There is no `disease -> biological_process` edge. The mechanism node's
"pathways for a disease" is a two-hop traversal through proteins:

```cypher
MATCH (d:Node {id: $id})-[:`associated with`]-(g:Node {type: 'gene/protein'})
                         -[:`interacts with`]-(p:Node {type: 'biological_process'})
WITH p, count(DISTINCT g) AS shared
ORDER BY shared DESC
LIMIT $limit
RETURN p.id, p.name
```

`shared` (count of distinct proteins linking the disease to the pathway)
is our proxy for "how disease-relevant is this pathway." It's coarse —
generic transcription / cell-cycle BPs dominate the top of the list for
most cancers — but it's the only signal we have without external
pathway scoring data. Downstream the LLM filters these to clinically
meaningful entries.

## Driver hygiene

- `apps/agent/src/tools/kg.ts` holds a single shared `Driver`. Don't
  create per-query drivers.
- Always close sessions in a `finally` block — vitest will hang on test
  exit otherwise.
- Concurrent fan-out across conditions is fine (`Promise.all`) — the
  driver multiplexes sessions on one connection.

## Ad-hoc exploration

For interactive Cypher exploration during development, use the
[`mcp-neo4j`](https://github.com/neo4j-contrib/mcp-neo4j) server —
install once, then Cypher tools become available in Claude Code
sessions. The MCP server is dev-only; the agent always goes through
`kg.ts`.

The Neo4j Browser at http://localhost:7474 is also fine, but the MCP
server is faster when working with Claude.

## Where to put new queries

- One-shot exploration → MCP server / Browser, don't commit.
- Query used by exactly one node → inline `const FOO_CYPHER = ` inside
  `kg.ts`, exported only if testing the node needs to assert query
  shape.
- Query reused across nodes / subgraphs → extract a helper function on
  `kg.ts` returning typed `KGNode` / `KGPath` shapes (not raw records).
