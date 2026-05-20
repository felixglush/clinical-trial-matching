# Scripts

## generate-patients.sh

Generates a deterministic 200-patient pool via [Synthea](https://github.com/synthetichealth/synthea) into `data/synthea-output/`. The four archetype patients are resolved by UUID from that pool by the loaders ([apps/agent/src/tools/patient-loader.ts](../apps/agent/src/tools/patient-loader.ts), [apps/web/src/lib/patients-loader.ts](../apps/web/src/lib/patients-loader.ts)) — no copy step. The selection lives in [packages/shared/src/patient-fixtures.ts](../packages/shared/src/patient-fixtures.ts).

**Requires:**
- Java 11+ (`brew install openjdk@17` on macOS).
- `data/synthea-with-dependencies.jar` — download from [synthea releases](https://github.com/synthetichealth/synthea/releases/latest).

```bash
pnpm patients:generate
```

Archetypes:

| Slug | Patient | Why |
|---|---|---|
| `hedy-sauer`      | F 54 | Clean breast cancer + obesity + prediabetes — minimal-noise oncology baseline |
| `brady-schmidt`   | M 66 | Clean NSCLC stage 1 + obesity — exercises lung-cancer KG paths and metformin/statin repurposing |
| `pamela-lesch`    | F 66 | Breast cancer + T2DM + CKD stages 1–3 + IHD + HTN, active smoker — stress-tests eligibility logic and repurposing rationale |
| `marvin-weissnat` | M 40 | Rheumatoid arthritis on NSAIDs/opioids (no DMARDs) — non-oncology cohort, cross-disease repurposing |

`data/synthea-output/` is gitignored — re-run this script on a fresh clone. To regenerate, delete the directory and run again.

## build-primekg-subset.ts

Downloads PrimeKG node and edge CSVs from Harvard Dataverse (~600 MB total), filters to the prototype subset (drug, disease, gene/protein, biological_process), and writes filtered CSVs to `data/kg/`.

```bash
pnpm kg:build-subset
```

`data/kg/` is gitignored — re-run this script on a fresh clone.

## load-primekg-to-neo4j.sh (+ .cypher)

`pnpm kg:load` runs the bash wrapper, which sources `apps/agent/.env`, auto-detects the Neo4j Desktop import directory on macOS, symlinks `data/kg/{nodes,edges}.csv` into it (so the Cypher script's `file:///` paths resolve), locates the bundled `cypher-shell`, and executes [load-primekg-to-neo4j.cypher](./load-primekg-to-neo4j.cypher).

The Cypher creates a uniqueness constraint on `:Node(id)` and indexes on `name` and `type`, then bulk-loads nodes (TSV) and edges (CSV, with APOC for per-row relationship types) in 5000-row transactions.

Prereqs:
- Neo4j Desktop running with a DBMS started, and the **APOC** plugin installed.
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` set in `apps/agent/.env`.
- Filtered CSVs already in `data/kg/` (run `pnpm kg:build-subset` first).
- Optional overrides: `NEO4J_IMPORT_DIR` (e.g., for a non-default DBMS location), `NEO4J_CYPHER_SHELL`.

```bash
pnpm kg:load
```

Expect 30–60 minutes for the full ~80K nodes / ~4M edges load.
