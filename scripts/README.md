# Scripts

## generate-patients.sh

Generates synthetic FHIR patient bundles via [Synthea](https://github.com/synthetichealth/synthea).

**Requires:** Java 11+

```bash
pnpm patients:generate          # 10 patients (default)
pnpm patients:generate -- 50    # 50 patients
```

Output lands in `data/patients/`. The script clones Synthea into `.synthea/` on first run (gitignored).

## build-primekg-subset.ts

Downloads PrimeKG node and edge CSVs from Harvard Dataverse (~600 MB total), filters to the prototype subset (drug, disease, gene/protein, biological_process), and writes filtered CSVs to `data/kg/`.

```bash
pnpm kg:build-subset
```

`data/kg/` is gitignored — re-run this script on a fresh clone.

## load-primekg-to-neo4j.cypher

Bulk-loads the filtered CSVs from `data/kg/` into a local Neo4j instance using `LOAD CSV WITH HEADERS`. Creates uniqueness constraints on node `id` and indexes on `name`, `type` before loading.

Prereqs:
- Neo4j running locally (Neo4j Desktop or `docker run neo4j`).
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` set in shell (or in `apps/agent/.env` and exported).
- `cypher-shell` on PATH (ships with Neo4j Desktop and the official Docker image).
- Filtered CSVs already in `data/kg/` (run `pnpm kg:build-subset` first).

```bash
pnpm kg:load
```
