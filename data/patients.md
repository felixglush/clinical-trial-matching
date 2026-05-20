# Patient fixtures

Four Synthea-generated FHIR bundles selected to exercise different parts of the matching workflow. The catalog lives in [packages/shared/src/patient-fixtures.ts](../packages/shared/src/patient-fixtures.ts); the underlying bundles are produced by [scripts/generate-patients.sh](../scripts/generate-patients.sh) into `data/synthea-output/` (gitignored).

Each patient is picked to surface bugs that only appear under specific conditions — together they cover two cancer types (breast/lung) × two complexity levels (clean/comorbid) plus one non-cancer chronic disease.

## hedy-sauer

**F 54** · Clean breast cancer (+ obesity, prediabetes).

Happy-path baseline. Use her when developing any single node. Clean signal: one major condition that maps to well-studied KG pathways (ER/PR/HER2/PI3K), tons of recruiting trials on CT.gov, no eligibility landmines. If a node behaves weirdly on Hedy, the bug isn't from data noise.

## brady-schmidt

**M 66** · Clean NSCLC stage 1 (+ obesity).

Second cancer type, prevents the workflow from accidentally hardcoding to breast cancer. NSCLC has different driver biology (EGFR/KRAS/ALK), so `identify_relevant_mechanisms` and `mechanism_plausibility` get exercised on a separate KG subgraph. Stage 1 = early disease, so eligibility doesn't get filtered out by "advanced disease only" criteria. Good for testing repurposing too — metformin/statins/aspirin in NSCLC are real research areas, so `find_repurposing_candidates` should surface them with PubMed support.

## pamela-lesch

**F 66** · Breast cancer + T2DM + CKD stages 1–3 + IHD + HTN, active smoker. On metformin, insulin, lisinopril, statin, clopidogrel.

The stress test. Specifically validates:

- `eligibility_check`: smoker exclusion, renal-function exclusion (CKD stage 3 = eGFR floor), cardiac exclusion, drug interactions. This is where eligibility logic earns its complexity.
- `find_repurposing_candidates`: she's already on metformin, so if metformin pops up as a repurposing candidate for her breast cancer, the workflow needs to handle "already on it" gracefully (notable insight, not a recommendation).
- `rank_and_synthesize`: trade-offs between disease axes (her cardiac risk reshapes trial fit).
- Realism check: most real cancer patients look more like Pamela than Hedy.

## marvin-weissnat

**M 40** · Rheumatoid arthritis on NSAIDs + opioids (no DMARDs).

Non-oncology, proving the workflow generalizes beyond cancer. RA → JAK-inhibitor repurposing across diseases is the textbook example for `find_repurposing_candidates` (e.g., tofacitinib originally for RA, now used in UC). Young + low-comorbidity = different eligibility profile from the cancer cohort. Also drives PubMed literature retrieval across non-oncology journals, which often surfaces different `literature_support` behavior.

## How to use

As you build each node, run all four in Studio (or via the web app) and see which ones break — the failure pattern tells you whether the bug is condition-specific, comorbidity-specific, or general.
