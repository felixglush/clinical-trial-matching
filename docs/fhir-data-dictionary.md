# FHIR Data Dictionary

Canonical FHIR R4 (v4.0.1) field semantics for every resource consumed by
[`apps/agent/src/nodes/extract-patient-profile.ts`](../apps/agent/src/nodes/extract-patient-profile.ts).
Use this when adding fields to the extractor, updating filters, or sanity-checking
that a downstream consumer is interpreting a code correctly.

**Sources:** [FHIR R4 spec](https://hl7.org/fhir/R4/), specifically the
[resource pages](#references) listed at the bottom.

**Conventions:**

- Cardinality follows FHIR notation: `0..1` = optional single, `1..1` = required
  single, `0..*` = optional list, `1..*` = required list.
- "Our handling" describes the current extractor behavior. `keep` / `drop` /
  `transform` indicate the value's fate in the produced `PatientProfile`.
- "⚠️" calls out a known mismatch between the FHIR spec and our extractor.

## Table of contents

- [Patient](#patient)
- [Condition](#condition)
- [Observation](#observation)
- [MedicationRequest](#medicationrequest)
- [MedicationAdministration](#medicationadministration)
- [Procedure](#procedure)
- [Resources we ignore entirely](#resources-we-ignore-entirely)
- [Known mismatches and gaps](#known-mismatches-and-gaps)
- [References](#references)

---

## Patient

| FHIR field             | Cardinality | FHIR type | Allowed values                       | Our handling                                                                                  |
| ---------------------- | ----------- | --------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `birthDate`            | `0..1`      | date      | ISO `YYYY-MM-DD`                     | Used with `now` to compute `ageYears`. Missing → age `0`.                                     |
| `gender`               | `0..1`      | code      | `male`, `female`, `other`, `unknown` | Mapped 1:1 to `sex`. Any other string → `unknown`.                                            |
| `deceasedBoolean`      | `0..1` *(choice)* | boolean | `true` / `false`                     | If `true`, sets `deceased = true` (no date).                                                  |
| `deceasedDateTime`     | `0..1` *(choice)* | dateTime | ISO 8601                              | If present, sets `deceased = true` and `deceasedDate = <that>`. Takes precedence over boolean. |
| `name`                 | `0..*`      | HumanName | —                                    | **Ignored.** We use the fixture's `displayName` for privacy/repeatability.                    |
| `extension` (race)     | `0..*`      | Extension | US-Core `ombCategory`                | **Ignored.** Tier-2 candidate — some trials are demographically restricted.                   |
| `extension` (ethnicity)| `0..*`      | Extension | US-Core `ombCategory`                | **Ignored.** Tier-2 candidate.                                                                |
| `extension` (birthsex) | `0..*`      | Extension | US-Core code                          | **Ignored.** Distinct from administrative `gender`; matters for sex-linked-trait trials.      |
| `address`              | `0..*`      | Address   | —                                    | **Ignored.**                                                                                  |
| `communication`        | `0..*`      | BackboneElement | —                              | **Ignored.** Language matters for informed-consent operations.                                |

### AdministrativeGender value set

| Code      | Meaning   |
| --------- | --------- |
| `male`    | Male.     |
| `female`  | Female.   |
| `other`   | Other.    |
| `unknown` | Unknown.  |

---

## Condition

| FHIR field            | Cardinality | FHIR type        | Allowed values                                                             | Our handling                                                                                                 |
| --------------------- | ----------- | ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `clinicalStatus`      | `0..1`      | CodeableConcept  | See [ConditionClinicalStatus](#conditionclinicalstatus) (6 values)         | First `coding[].code` mapped 1:1 to our 6-value enum. Unrecognized values → `undefined`. |
| `verificationStatus`  | `0..1`      | CodeableConcept  | See [ConditionVerificationStatus](#conditionverificationstatus) (6 values) | Filter: drop if explicit ≠ `confirmed`. Missing is lenient (kept).                                            |
| `code`                | `0..1`      | CodeableConcept  | Any                                                                        | `pickCoding` prefers SNOMED CT; falls back to `coding[0]`. The chosen `system` is recorded on the output.    |
| `onsetDateTime`       | `0..1` *(choice)* | dateTime  | ISO 8601                                                                   | Captured as `onsetDate`. Falls back to `recordedDate`.                                                       |
| `abatementDateTime`   | `0..1` *(choice)* | dateTime  | ISO 8601                                                                   | Captured as `abatementDate`. Other abatement choices (`abatementAge`, `abatementPeriod`, etc.) are ignored. |
| `recordedDate`        | `0..1`      | dateTime         | ISO 8601                                                                   | Fallback for `onsetDate`.                                                                                    |
| `severity`            | `0..1`      | CodeableConcept  | SNOMED severity codes                                                      | **Ignored.** Tier-2 candidate.                                                                               |
| `stage`               | `0..*`      | BackboneElement  | —                                                                          | **Ignored.** Cancer staging matters for oncology trials.                                                     |
| `evidence`            | `0..*`      | BackboneElement  | —                                                                          | **Ignored.**                                                                                                 |
| `category`            | `0..*`      | CodeableConcept  | `problem-list-item`, `encounter-diagnosis`                                 | **Ignored.** All Synthea conditions are `encounter-diagnosis`; using this for filtering would not distinguish social findings from real diagnoses. |
| `bodySite`            | `0..*`      | CodeableConcept  | —                                                                          | **Ignored.**                                                                                                 |

### ConditionClinicalStatus

| Code         | Meaning (paraphrased)                                                                                | Schema-side                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `active`     | Subject is currently experiencing symptoms.                                                          | Kept. Dedupe treats as "currently present."                  |
| `recurrence` | Re-occurrence of a previously resolved condition (UTI, pancreatitis, conjunctivitis).                | Kept. Dedupe treats as "currently present."                  |
| `relapse`    | Return of condition after a period of improvement or remission (cancer, MS, RA, bipolar, etc.).      | Kept. Dedupe treats as "currently present" (load-bearing for oncology trials). |
| `inactive`   | No longer experiencing symptoms.                                                                     | Kept.                                                        |
| `remission`  | No symptoms, but risk of return.                                                                     | Kept.                                                        |
| `resolved`   | No symptoms and negligible risk of return.                                                           | Kept.                                                        |

### ConditionVerificationStatus

| Code               | Meaning (paraphrased)                                                            | Our filter |
| ------------------ | -------------------------------------------------------------------------------- | ---------- |
| `unconfirmed`      | Not sufficient evidence yet.                                                     | **Drop**.  |
| `provisional`      | Tentative diagnosis under consideration.                                         | **Drop**.  |
| `differential`     | One of several mutually exclusive candidate diagnoses.                           | **Drop**.  |
| `confirmed`        | Sufficient evidence to treat as confirmed.                                       | **Keep**.  |
| `refuted`          | Ruled out by diagnostic / clinical evidence.                                     | **Drop**.  |
| `entered-in-error` | Statement was entered in error and is invalid.                                   | **Drop**.  |

Synthea always emits `confirmed`, so this filter has no effect on current
fixtures; it's defensive against real-EHR data.

---

## Observation

| FHIR field            | Cardinality | FHIR type        | Allowed values                                              | Our handling                                                                                                  |
| --------------------- | ----------- | ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `status`              | `1..1`      | code             | See [ObservationStatus](#observationstatus) (8 values)      | Filter: keep `final` / `amended` / `corrected`; drop everything else. Missing is lenient (kept).               |
| `category`            | `0..*`      | CodeableConcept  | See [ObservationCategory](#observationcategory) (9 values)  | Filter: keep only if any `coding.code` is `laboratory` or `vital-signs`.                                       |
| `code`                | `1..1`      | CodeableConcept  | Any                                                         | `pickCoding` prefers LOINC; falls back to `coding[0]`. Recorded on the output.                                 |
| `effectiveDateTime`   | `0..1` *(choice)* | dateTime  | ISO 8601                                                    | Used as the observation date. Falls back to `issued`.                                                          |
| `effectivePeriod`     | `0..1` *(choice)* | Period    | —                                                           | **Ignored** — Synthea emits `effectiveDateTime`. May matter for ambulatory monitoring data later.              |
| `issued`              | `0..1`      | instant          | ISO 8601                                                    | Fallback for date.                                                                                            |
| `valueQuantity`       | `0..1` *(choice)* | Quantity  | `{ value, unit, system, code }`                             | `value` and `unit` are captured. `system` and `code` (UCUM) are dropped.                                       |
| `valueString`         | `0..1` *(choice)* | string    | —                                                           | Captured as `value`. Other value choices (`valueBoolean`, `valueCodeableConcept`, `valueRange`, ...) ignored. |
| `component`           | `0..*`      | BackboneElement  | —                                                           | Each component is unfolded into its own Lab (e.g. BP panel → systolic + diastolic). Component date inherits from parent. |
| `interpretation`      | `0..*`      | CodeableConcept  | High/low/normal codes                                       | **Ignored.** Tier-2 candidate — saves downstream from reimplementing reference-range checks.                   |
| `referenceRange`      | `0..*`      | BackboneElement  | —                                                           | **Ignored.**                                                                                                  |
| `bodySite`            | `0..1`      | CodeableConcept  | —                                                           | **Ignored.**                                                                                                  |

### ObservationStatus

| Code               | Meaning (paraphrased)                                                              | Our filter |
| ------------------ | ---------------------------------------------------------------------------------- | ---------- |
| `registered`       | Observation exists; no result yet.                                                 | **Drop.**  |
| `preliminary`      | Initial / interim; data may be incomplete or unverified.                           | **Drop.**  |
| `final`            | Complete and verified.                                                             | **Keep.**  |
| `amended`          | Was final, then updated (additional info; may include corrections).                | **Keep.**  |
| `corrected`        | Was final, then the value was corrected.                                           | **Keep.**  |
| `cancelled`        | Measurement was not started or not completed.                                      | **Drop.**  |
| `entered-in-error` | Withdrawn after finalization; never should have existed.                           | **Drop.**  |
| `unknown`          | Source system doesn't know which status applies.                                   | **Drop.**  |

### ObservationCategory

| Code             | Meaning (paraphrased)                                                                 | Our filter   |
| ---------------- | ------------------------------------------------------------------------------------- | ------------ |
| `social-history` | Occupational, lifestyle, social, familial, environmental history.                     | **Drop.** Aligns with social-code condition filtering. |
| `vital-signs`    | Body's basic functions (BP, HR, RR, height, weight, BMI).                             | **Keep.**    |
| `imaging`        | Observations generated by imaging (x-ray, US, CT, MRI, angiography).                  | **Drop.** (Imaging metadata not modeled.) |
| `laboratory`     | Results from analytic laboratories.                                                   | **Keep.**    |
| `procedure`      | Observations from procedures (interventional and non-interventional).                 | **Drop.**    |
| `survey`         | Assessment tools / survey instruments (Apgar, MoCA).                                  | **Drop.**    |
| `exam`           | Physical exam findings.                                                               | **Drop.**    |
| `therapy`        | Non-interventional treatments (OT, PT, radiation, nutrition, medication therapy).     | **Drop.**    |
| `activity`       | Activity that maintains physical fitness.                                             | **Drop.**    |

---

## MedicationRequest

| FHIR field                 | Cardinality | FHIR type        | Allowed values                                                  | Our handling                                                                            |
| -------------------------- | ----------- | ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `status`                   | `1..1`      | code             | See [MedicationRequestStatus](#medicationrequeststatus) (8 vals) | Filter: drop event entirely if status ∈ {`cancelled`, `entered-in-error`, `draft`, `unknown`}. Surviving values normalize 1:1 into our 5-value enum (`active`, `on-hold`, `stopped`, `completed`, `in-progress` for MedAdmin). |
| `intent`                   | `1..1`      | code             | `proposal`, `plan`, `order`, ...                                | **Ignored.** Synthea emits `order`.                                                     |
| `medicationCodeableConcept`| `0..1` *(choice)* | CodeableConcept | Any                                                       | `pickCoding` prefers RxNorm; falls back to `coding[0]`. Recorded on the output.        |
| `medicationReference`      | `0..1` *(choice)* | Reference | —                                                               | **Ignored.** Synthea always inlines `medicationCodeableConcept`.                       |
| `authoredOn`               | `0..1`      | dateTime         | ISO 8601                                                        | Required for event sequencing — events without it are dropped.                          |
| `dosageInstruction`        | `0..*`      | Dosage           | —                                                               | **Ignored.** Tier-2 candidate — needed for dose-dependent eligibility ("≥80mg aspirin"). |
| `dispenseRequest`          | `0..1`      | BackboneElement  | quantity, refills, validity period                              | **Ignored.**                                                                            |
| `reasonCode` / `reasonReference` | `0..*` | CodeableConcept / Reference | —                                                | **Ignored.** Tier-2 candidate.                                                          |
| `category`                 | `0..*`      | CodeableConcept  | `community`, `inpatient`, etc.                                   | **Ignored.**                                                                            |

### MedicationRequestStatus

| Code               | Meaning (paraphrased)                                                            | Schema-side                                                  |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `active`           | Prescription is actionable; not yet all implied actions done.                    | Kept.                                                        |
| `on-hold`          | Temporarily halted, expected to continue later.                                  | Kept. Distinct from `stopped`.                               |
| `cancelled`        | Withdrawn before any administrations occurred.                                   | **Event dropped.**                                           |
| `completed`        | All implied actions occurred.                                                    | Kept.                                                        |
| `entered-in-error` | Request contains errors; should be excluded from decision-support.               | **Event dropped.**                                           |
| `stopped`          | Permanently halted before all administrations occurred.                          | Kept.                                                        |
| `draft`            | Not yet actionable (work in progress, awaiting sign-off).                        | **Event dropped.**                                           |
| `unknown`          | Source system doesn't know which status applies.                                 | **Event dropped.**                                           |

---

## MedicationAdministration

| FHIR field                 | Cardinality | FHIR type        | Allowed values                                                       | Our handling                                                                            |
| -------------------------- | ----------- | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `status`                   | `1..1`      | code             | See [MedicationAdministrationStatus](#medicationadministrationstatus) | Same filter as MedicationRequest: drop event entirely if status ∈ {`not-done`, `entered-in-error`, `unknown`}; otherwise pass through to our 5-value enum (`in-progress`, `on-hold`, `stopped`, `completed`). |
| `medicationCodeableConcept`| `0..1` *(choice)* | CodeableConcept | Any                                                            | Same handling as MedicationRequest — RxNorm preferred.                                  |
| `effectiveDateTime`        | `0..1` *(choice)* | dateTime  | ISO 8601                                                             | Used as event date. Required for sequencing.                                            |
| `effectivePeriod`          | `0..1` *(choice)* | Period    | —                                                                    | **Ignored.**                                                                            |
| `dosage`                   | `0..1`      | BackboneElement  | —                                                                    | **Ignored.**                                                                            |
| `reasonReference`          | `0..*`      | Reference        | —                                                                    | **Ignored.**                                                                            |

### MedicationAdministrationStatus

| Code               | Meaning (paraphrased)                                                            | Schema-side                                                  |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `in-progress`      | Administration has started but not yet completed.                                | Kept.                                                        |
| `not-done`         | Terminated prior to any impact on subject.                                       | **Event dropped.**                                           |
| `on-hold`          | Temporarily halted.                                                              | Kept.                                                        |
| `completed`        | All implied actions occurred.                                                    | Kept.                                                        |
| `entered-in-error` | Entered in error; nullified.                                                     | **Event dropped.**                                           |
| `stopped`          | Permanently halted before completion.                                            | Kept.                                                        |
| `unknown`          | Source system doesn't know.                                                      | **Event dropped.**                                           |

---

## Procedure

| FHIR field            | Cardinality | FHIR type        | Allowed values                                          | Our handling                                                                            |
| --------------------- | ----------- | ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `status`              | `1..1`      | code             | See [EventStatus](#eventstatus) (8 values)              | Filter: drop procedure entirely if status ∈ {`not-done`, `entered-in-error`, `unknown`}. Other statuses (including `preparation`, `in-progress`, `on-hold`, `stopped`, `completed`) pass through. Missing status is lenient. |
| `code`                | `0..1`      | CodeableConcept  | Any                                                     | `pickCoding` prefers SNOMED CT.                                                          |
| `performedDateTime`   | `0..1` *(choice)* | dateTime  | ISO 8601                                                | Used as the procedure date.                                                              |
| `performedPeriod`     | `0..1` *(choice)* | Period    | `{ start, end }`                                        | Falls back to `performedPeriod.start`.                                                   |
| `reasonReference`     | `0..*`      | Reference        | Link to Condition or Observation                        | **Ignored.** Tier-2 candidate — "for which condition?"                                   |
| `bodySite`            | `0..*`      | CodeableConcept  | —                                                       | **Ignored.** Tier-2 candidate — laterality matters for breast/lung-cancer trials.        |
| `outcome`             | `0..1`      | CodeableConcept  | —                                                       | **Ignored.**                                                                            |
| `complication`        | `0..*`      | CodeableConcept  | —                                                       | **Ignored.**                                                                            |
| `usedReference`       | `0..*`      | Reference        | Devices, medications used                               | **Ignored.**                                                                            |

### EventStatus

(Shared by Procedure, ServiceRequest, and others.)

| Code               | Meaning (paraphrased)                                              | Our filter |
| ------------------ | ------------------------------------------------------------------ | ---------- |
| `preparation`      | Core event not started; staging begun.                             | Keep.      |
| `in-progress`      | Currently occurring.                                               | Keep.      |
| `not-done`         | Terminated prior to any activity beyond preparation.               | **Drop.**  |
| `on-hold`          | Temporarily stopped; expected to resume.                           | Keep.      |
| `stopped`          | Terminated after some activity, before completion.                 | Keep.      |
| `completed`        | Concluded.                                                         | Keep.      |
| `entered-in-error` | Should never have existed.                                         | **Drop.**  |
| `unknown`          | Source system doesn't know.                                        | **Drop.**  |

---

## Resources we ignore entirely

These appear in Synthea bundles but never reach `PatientProfile`:

| Resource             | Why ignored (today)                                                                 | When to revisit                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Encounter`          | We don't reason over encounters directly.                                           | If trial criteria need "≥ N visits to specialty X" or hospitalization history.                        |
| `CarePlan`           | Long-horizon care narratives; LLM-only consumption.                                 | When we want goal-of-care context for the LLM.                                                        |
| `CareTeam`           | Provider relationships, not patient state.                                          | Probably never relevant to matching.                                                                  |
| `Device`             | Implanted devices (pacemakers, stents) are real trial exclusions.                   | Tier-2 candidate.                                                                                     |
| `DiagnosticReport`   | High-signal: pathology (receptor status, tumor grade), radiology impressions.       | Highest-value un-modeled resource. Needs LLM extraction from `presentedForm` or `result[]` walks.     |
| `DocumentReference`  | Clinical notes (free text). Needs LLM extraction.                                   | When we need narrative context (history of present illness, etc.).                                    |
| `ImagingStudy`       | Imaging metadata (modality, body part). The reports are in `DiagnosticReport`.      | If we model imaging history for radiation-exposure or recent-scan criteria.                           |
| `Immunization`       | Vaccination history.                                                                | For live-virus or immunotherapy trials.                                                               |
| `AllergyIntolerance` | **Not emitted by current Synthea config**, but a top-tier trial exclusion criterion. | First-class once real-EHR data lands.                                                                |
| `FamilyMemberHistory`| Not emitted by Synthea.                                                             | For genetic-risk-stratified trials (BRCA, Lynch).                                                     |
| `Claim` / `EOB`      | Billing data; rarely useful for eligibility.                                        | Probably never.                                                                                       |
| `SupplyDelivery`     | DME / supply tracking.                                                              | Probably never.                                                                                       |
| `Provenance`         | Source-tracking metadata.                                                           | If we need data-source attestation for regulatory reasons.                                            |

---

## Known mismatches and gaps

### Discarded high-signal fields (Tier-2)

Fields present in FHIR that we choose not to model yet. Each is a separate
deliberate decision and can be lifted when a downstream consumer needs it.

1. `MedicationRequest.dosageInstruction` — dose-dependent criteria can't be evaluated (e.g., "high-dose corticosteroid," "≥ 80mg aspirin daily").
2. `Observation.interpretation` / `referenceRange` — Synthea doesn't emit them, but real EHRs do; saves downstream from reimplementing high/low/normal logic.
3. `Procedure.bodySite` — laterality (which breast, which lung) matters for cancer trials.
4. `Procedure.reasonReference` — link procedure → motivating Condition.
5. `Condition.severity`, `Condition.stage` — especially cancer stage / TNM.
6. `Patient.extension` for race / ethnicity / birthsex — demographic-restricted trials.

### Resource types not yet modeled

7. `AllergyIntolerance` — top-tier trial exclusion. Synthea doesn't emit it in the current config; revisit when real-EHR data lands.
8. `DiagnosticReport` — pathology / radiology reports often hold the key signal (receptor status, tumor grade) that `Condition` rows don't.
9. `DocumentReference` — clinical notes. LLM-extraction territory.

### Choice-type variants we don't handle

10. `Condition.abatementAge` / `abatementPeriod` / `abatementRange` / `abatementString` / `abatementBoolean` — only `abatementDateTime` is captured.
11. `Observation.effectivePeriod` / `effectiveInstant` / `effectiveTiming` — only `effectiveDateTime` is captured.
12. `Observation.valueBoolean` / `valueInteger` / `valueRange` / `valueRatio` / `valueSampledData` / `valueTime` / `valueCodeableConcept` — only `valueQuantity` and `valueString` are captured.

---

## References

- [FHIR R4 specification (v4.0.1)](https://hl7.org/fhir/R4/)
- [Patient resource](https://hl7.org/fhir/R4/patient.html)
- [Condition resource](https://hl7.org/fhir/R4/condition.html) — [clinicalStatus value set](https://hl7.org/fhir/R4/valueset-condition-clinical.html) — [verificationStatus value set](https://hl7.org/fhir/R4/valueset-condition-ver-status.html)
- [Observation resource](https://hl7.org/fhir/R4/observation.html) — [status value set](https://hl7.org/fhir/R4/valueset-observation-status.html) — [category value set](https://hl7.org/fhir/R4/valueset-observation-category.html)
- [MedicationRequest resource](https://hl7.org/fhir/R4/medicationrequest.html) — [status value set](https://hl7.org/fhir/R4/valueset-medicationrequest-status.html)
- [MedicationAdministration resource](https://hl7.org/fhir/R4/medicationadministration.html) — [status value set](https://hl7.org/fhir/R4/valueset-medication-admin-status.html)
- [Procedure resource](https://hl7.org/fhir/R4/procedure.html) — [EventStatus value set](https://hl7.org/fhir/R4/valueset-event-status.html)
- [AdministrativeGender value set](https://hl7.org/fhir/R4/valueset-administrative-gender.html)
- [SNOMED CT](https://www.snomed.org/)
- [LOINC](https://loinc.org/)
- [RxNorm](https://www.nlm.nih.gov/research/umls/rxnorm/)
- [US Core profiles](https://hl7.org/fhir/us/core/) (Synthea uses US-Core profiles)
