# Biomedical primer for engineers

Onboarding for the biology and the knowledge graph this project is built on.

## The TL;DR

This project's job is to take a patient's medical record and decide which clinical trials to consider for them. Standard eligibility-matching tools handle "is the patient eligible?" — we add a layer of **biological reasoning**: *why* might a given trial's drug actually work for this patient's disease, and are there other approved drugs that could be repurposed for them?

That reasoning is grounded in two things:

1. **PrimeKG** — a graph of facts about diseases, genes, drugs, and pathways. *What's connected to what.*
2. **TxGNN** — a machine-learning model that read PrimeKG and predicts *which drugs are likely to treat which diseases*, including pairings no one has tried yet.

The rest of this doc explains those two and what we mean by "mechanism".

## Five concepts you need

### 1. Disease

A medical diagnosis. Examples: type-2 diabetes, breast cancer, sickle-cell anemia. The patient input (a FHIR record from Synthea) lists diseases using **SNOMED codes** — a standard clinical vocabulary.

PrimeKG identifies diseases using **MONDO codes** — a research-oriented ontology that's more granular than SNOMED. One of our first runtime steps translates between them; see [kg-crosswalk.md](kg-crosswalk.md).

### 2. Gene (and protein)

Genes are the instructions in DNA that tell a cell how to make a specific protein. Proteins do nearly everything in the cell — they signal, build structures, catalyze reactions.

When we say a gene is "associated with" a disease, we mean: in this disease, the protein that gene codes for is doing something wrong — broken, over-active, missing, or mutated. Example: in HER2-positive breast cancer, the `ERBB2` gene (which codes for the HER2 protein) is dramatically over-expressed, making cells divide too much.

PrimeKG has a single node type for both — `gene/protein` (with a slash — see [primekg-querying.md](primekg-querying.md#schema-crib-sheet)).

### 3. Pathway

A pathway is a chain of proteins that work together to do one thing. Examples:

- *MAPK signaling pathway* — relays growth signals from outside the cell to the nucleus
- *Insulin signaling pathway* — controls how cells respond to insulin
- *DNA repair pathway* — fixes broken DNA

If genes are individual workers, pathways are assembly lines. A disease is rarely about one gene — it's usually about a pathway being misregulated. That's why pathways are the right level of abstraction for drug reasoning.

In PrimeKG these are `biological_process` nodes.

### 4. Drug

A small molecule (or biologic) a patient takes, with a target it acts on — usually one or more proteins it binds to. Examples:

- Trastuzumab → targets HER2 protein
- Metformin → affects multiple targets in energy metabolism
- Atorvastatin → blocks HMG-CoA reductase

PrimeKG `drug` nodes have outgoing edges like:

- `target` → the protein the drug acts on
- `indication` → the disease it's approved to treat
- `contraindication` → the disease/condition for which it's dangerous
- `off-label use` → diseases doctors prescribe it for outside the approved label

### 5. Mechanism — the unifying concept

A **mechanism of disease** is the biological story of *how* a disease happens at the molecular level. It's the chain that links *disease ↔ genes ↔ pathway*.

Concrete example. HER2-positive breast cancer:

```text
breast cancer ── associated with ──► ERBB2 gene
                                       │
                                       │ interacts with
                                       ▼
                                  ERBB signaling pathway
                                       │
                                       │ interacts with
                                       ▼
                                   MAPK cascade
```

The mechanism is: *over-expressed HER2 → constant growth signal through the ERBB pathway → uncontrolled cell division.*

Knowing the mechanism unlocks treatment reasoning. "If growth signaling is the problem, block the receptor" → trastuzumab. "If MAPK is the problem, block downstream" → MEK inhibitors. Without the mechanism story, you only have a disease label and a list of drugs people happen to have tried.

In the codebase, `Mechanism` is a TypeScript type that captures this story for one disease:

```ts
{
  conditionId:     "MONDO:0007254",        // the disease
  conditionName:   "HER2-positive breast carcinoma",
  geneTargets:     [ERBB2, EGFR, ...],
  pathways:        ["ERBB signaling", "MAPK cascade", ...],
  supportingPaths: [/* disease → gene → pathway evidence trails */],
  rationale:       "LLM-written explanation",
}
```

## PrimeKG: the "what's connected to what"

PrimeKG is a graph database stored in Neo4j. Three things to know:

**Node types** (see [primekg-querying.md](primekg-querying.md) for the full table):

| Type | What it is | Approx. count |
| --- | --- | --- |
| `disease` | A diagnosis (MONDO id) | 17K |
| `gene/protein` | A gene or its protein | 28K |
| `biological_process` | A pathway / GO term | 29K |
| `drug` | An approved or investigational drug (DrugBank id) | 8K |

**Edge types** (12 total). The ones you'll see most:

| Edge | Meaning |
| --- | --- |
| `associated with` | gene/protein implicated in a disease |
| `interacts with` | two proteins, or a protein and a pathway |
| `target` | drug binds this protein |
| `indication` | drug is approved for this disease |
| `contraindication` | drug must not be given to patients with this condition |
| `off-label use` | drug is sometimes used outside its approved label |

**How we query it.** All access goes through `apps/agent/src/tools/kg.ts` via the Neo4j driver. We never reason globally over the graph — we always start from a node we care about (a patient's disease, a candidate drug) and walk one or two hops. The agent nodes that touch the KG:

- `identify-relevant-mechanisms` — *disease → gene → pathway*. Builds the mechanism story per patient condition.
- `find-repurposing-candidates` (currently stubbed; being replaced by a TxGNN lookup) — *disease → drug candidates*.
- `mechanism-plausibility` (inside `trial-eval` subgraph) — given a trial's intervention drug and a patient's mechanism, does a connecting path exist?
- `patient-fit` (planned, in the drug-eval design) — *drug → contraindication/side_effect → disease/phenotype*, intersected with the patient's profile.

For query mechanics and gotchas (the `gene/protein` slash, undirected matching, `neo4j.int(...)`, etc.), read [primekg-querying.md](primekg-querying.md).

## TxGNN: the "what might work"

PrimeKG tells you facts that are already known. It will tell you "metformin is indicated for type-2 diabetes" because someone wrote that edge into the graph. It *won't* tell you "this experimental kinase inhibitor might also help" — because no one's written that edge yet.

[TxGNN](https://www.nature.com/articles/s41591-024-03233-x) (Huang et al., Nature Medicine 2024) is a graph neural network that **learned the patterns of PrimeKG** and uses them to predict drug-disease pairings — including pairs that don't exist as edges in the graph. For any (drug, disease) pair, it outputs:

- `predIndication` — probability the drug treats the disease
- `predContraindication` — probability the drug is harmful in that disease

It's the current state of the art for *drug repurposing* — finding new uses for already-approved drugs, with strong zero-shot performance on diseases that have no approved treatments. Crucially, the lab released **pre-computed predictions** for ~17K diseases × ~8K drugs, so we don't need to host the model — we download the prediction table and look things up.

### Encyclopedia vs. recommender

The cleanest way to think about the split:

- **PrimeKG = the encyclopedia.** Look up facts: "what genes are associated with this disease?", "what does this drug target?", "what's contraindicated with this drug?" Always there.
- **TxGNN = the recommender that read the encyclopedia.** Pre-computed answers to "what drugs might work for disease X?", including for diseases with no approved treatments. Downloaded as a static lookup file.
- **The agent = the clinician.** Asks the encyclopedia for the patient's mechanism story, asks the recommender what might help, then weighs the answers against the patient's specific situation (other meds, comorbidities, active trials).

Both are needed. Neither replaces the other.

## Resolution caveat

PrimeKG (and by extension TxGNN) operates at the level of *associations*: "EGFR is implicated in NSCLC", "osimertinib targets EGFR". It does **not** know mutation-precise predictions like "EGFR T790M mutation predicts osimertinib response". For mutation-level matching we'd layer OncoKB / CIViC / COSMIC on top, but that's out of scope.

If a patient's record specifies a mutation that matters clinically, the agent currently sees it as just "EGFR-positive NSCLC" and won't distinguish T790M-positive from L858R-positive patients.

## Where to read next

- [primekg-querying.md](primekg-querying.md) — Cypher gotchas, schema crib sheet, query patterns
- [kg-crosswalk.md](kg-crosswalk.md) — SNOMED → MONDO resolution (how patient input maps to PrimeKG)
- [topology.md](topology.md) — which agent nodes consume which queries
- [fhir-data-dictionary.md](fhir-data-dictionary.md) — patient input format
- [superpowers/specs/](superpowers/specs/) — per-node design specs (the *why* behind each implementation)
