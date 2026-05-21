/**
 * # extract-patient-profile
 *
 * Builds a structured `PatientProfile` from a Synthea-shaped FHIR Bundle.
 * Pure transformation — no LLM.
 *
 * For canonical FHIR field semantics, value sets, and the rationale for
 * every filter / drop decision, see `docs/fhir-data-dictionary.md` at the
 * repo root. Whenever you add or change a filter here, update that doc
 * in the same change.
 *
 * ## Pipeline
 *
 * ```text
 *   FHIR Bundle (entry[].resource[])
 *       │
 *       │  bucketByType()  — single pass, split by resourceType
 *       ▼
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │ Patient                                                           │
 *   │   └─► ageYears(birthDate, now), normalizeSex(gender),             │
 *   │       patientDeceasedStatus() → deceased + deceasedDate           │
 *   │                                                                   │
 *   │ Condition[]                                                       │
 *   │   └─► toCondition()  ─► drop verificationStatus ≠ confirmed       │
 *   │                      ─► drop SOCIAL_CONDITION_CODES               │
 *   │                      ─► capture onsetDate + abatementDate         │
 *   │                      ─► dedupeConditions (active wins;            │
 *   │                                            then latest onset)     │
 *   │                                                                   │
 *   │ MedicationRequest[] + MedicationAdministration[]                  │
 *   │   └─► toMedicationEvent() ─► drop status ∈ {cancelled,            │
 *   │                                  entered-in-error, draft,         │
 *   │                                  not-done, unknown}               │
 *   │                            ─► groupMedicationEvents               │
 *   │             (one Medication per RxNorm; events sorted oldest      │
 *   │              → newest; no gap-based episode inference)            │
 *   │                                                                   │
 *   │ Observation[] (laboratory OR vital-signs, status=final)           │
 *   │   └─► toLabValues()  ─► unfold component[] (one point per metric) │
 *   │                      ─► groupLabValues (one Lab per LOINC;        │
 *   │                                          values sorted oldest →   │
 *   │                                          newest)                  │
 *   │                                                                   │
 *   │ Procedure[]                                                       │
 *   │   └─► toPriorTreatment() ─► drop status ∈ {not-done,              │
 *   │                                  entered-in-error, unknown}      │
 *   │                          ─► dedupePriorTreatments (latest wins)   │
 *   └───────────────────────────────────────────────────────────────────┘
 *       │
 *       ▼
 *   PatientProfileSchema.parse(...)   ← throws → caught by node → state.error
 * ```
 *
 * ## Coding system preference
 *
 * Every FHIR `CodeableConcept` carries a `coding[]` — multiple
 * representations of the same concept across terminologies. Order in the
 * array has no semantic meaning. `pickCoding(concept, preferredSystem)`
 * returns the coding whose `system` matches `preferredSystem`, falling
 * back to `coding[0]` if absent. The system actually used is recorded as
 * `record.system` on every produced item.
 *
 * Why fall back rather than drop? Real-world EHR feeds sometimes carry a
 * single non-canonical coding (e.g. ICD-10-only conditions). Dropping
 * them is silent data loss; falling back keeps the record visible.
 * Recording `system` makes the choice auditable downstream.
 *
 * Per-resource preferences and value-set details: see the data dictionary.
 *
 * ## Social-code filtering
 *
 * Synthea encodes social determinants (employment, education, isolation,
 * stress, ...) as `Condition` resources sharing the same
 * `category=encounter-diagnosis` as real diagnoses. There is no clean
 * categorical filter:
 *
 *   - Semantic-tag filter (drop `(finding)` / `(situation)`) is too broad
 *     — it would also drop clinically-relevant items like "Body mass
 *     index 30+ - obesity (finding)" and "Past pregnancy history of
 *     miscarriage (situation)".
 *   - SNOMED hierarchy traversal requires an external terminology
 *     service, out of scope here.
 *
 * Pragmatic answer: an explicit denylist (`SOCIAL_CONDITION_CODES`) of
 * Synthea-emitted social SNOMED codes. Extend it when a new social code
 * surfaces in a fixture. Tobacco/alcohol/pregnancy findings are kept on
 * purpose — they're real trial-eligibility signals.
 *
 * ## Dedup and start/stop history
 *
 * Conditions / Labs / Procedures are deduplicated by `code` — latest
 * onset/date wins, with `active` outranking other statuses for
 * Conditions. This is appropriate because their natural unit is "current
 * state per code": FHIR's `clinicalStatus` already encodes the most
 * recent transition, refilled labs only matter at their latest value,
 * and procedures are typically one-shot events.
 *
 * Medications use a different shape: one `Medication` row per RxNorm
 * code, carrying the **full chronological list of events** (one event
 * per source MedicationRequest or MedicationAdministration). This
 * preserves start/stop/restart cycles, which matter for eligibility
 * criteria like washout periods, cumulative exposure, and prior-therapy
 * recency. Episodes are derivable downstream (`now - events[last].date`,
 * gap detection over `events[].date`, etc.), and that derivation is
 * inherently drug-class-specific — chemotherapy cycles, weekly biologics,
 * and chronic-disease refills have different natural cadences, so a
 * single gap threshold here would over-split some classes and
 * under-split others. We leave that to consumers that know the drug.
 *
 * Practical consequences for the four common eligibility questions:
 *
 *   - Ever on X?            → `events.length > 0`
 *   - Currently on X?       → `events[last].status === "active"`
 *   - Time since last dose? → `now - events[last].date`
 *   - Total exposure?       → consumer aggregates `events[]`
 *
 * ## Observations: labs, vitals, component unfolding, event lists
 *
 * The `labs` field accepts both `laboratory` and `vital-signs`
 * observations — both are quantitative measurements with LOINC codes
 * worth retaining for eligibility checks. Some panels (e.g. blood
 * pressure, LOINC 85354-9) carry no parent value but two `component[]`
 * entries (systolic 8480-6, diastolic 8462-4); these are unfolded so
 * each component becomes a separate measurement under its own LOINC code.
 *
 * Each `Lab` carries the full chronological `values` series rather than
 * just the latest value. Rationale parallels Medications: trial criteria
 * routinely involve trends ("HbA1c < 7% for ≥ 6 months," "stable
 * creatinine clearance," "declining tumor markers"), which a
 * latest-value-only shape cannot answer. Consumers that only need the
 * current value read `values[values.length - 1]`.
 *
 * Per-status filter rules and the list of dropped/kept FHIR statuses for
 * each resource live in the data dictionary alongside their FHIR value-set
 * definitions. Filters are missing-status-lenient (kept) so partial
 * sources don't lose data over absent metadata.
 */

import {
  PATIENT_FIXTURES,
  PatientProfileSchema,
  type Condition,
  type Lab,
  type LabValue,
  type Medication,
  type MedicationEvent,
  type PatientFixture,
  type PatientProfile,
  type PriorTreatment,
} from "@clinical-trial-matching/shared";

import { loadPatientBundle } from "../tools/patient-loader.js";
import type { AgentStateType } from "../state.js";

export async function extractPatientProfile(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const fixture = PATIENT_FIXTURES.find((f) => f.slug === state.patientId);
  if (!fixture) {
    return { error: `Unknown patient: ${state.patientId}` };
  }

  const bundle = await loadPatientBundle(state.patientId);

  try {
    const patientProfile = buildPatientProfile(bundle, fixture, new Date());
    return { patientProfile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to build profile for ${state.patientId}: ${message}` };
  }
}

// ---------- Pure builder (testable) ----------

export function buildPatientProfile(
  bundle: unknown,
  fixture: PatientFixture,
  now: Date,
): PatientProfile {
  const b = bundle as FhirBundle;
  if (b?.resourceType !== "Bundle" || !Array.isArray(b.entry)) {
    throw new Error("Bundle is not a FHIR Bundle");
  }
  const buckets = bucketByType(b.entry.map((e) => e.resource));

  if (!buckets.patient) throw new Error("Bundle has no Patient resource");

  const { deceased, deceasedDate } = patientDeceasedStatus(buckets.patient);

  return PatientProfileSchema.parse({
    id: fixture.slug,
    displayName: fixture.displayName,
    ageYears: ageYears(buckets.patient.birthDate, now),
    sex: normalizeSex(buckets.patient.gender),
    deceased,
    deceasedDate,
    conditions: dedupeConditions(
      buckets.conditions
        .map(toCondition)
        .filter((c): c is Condition => c !== null)
        .filter((c) => !SOCIAL_CONDITION_CODES.has(c.code)),
    ),
    medications: groupMedicationEvents([
      ...buckets.medicationRequests.map((r) => toMedicationEvent(r, "request")),
      ...buckets.medicationAdministrations.map((r) =>
        toMedicationEvent(r, "administration"),
      ),
    ].filter((e): e is RxEvent => e !== null)),
    labs: groupLabValues(
      buckets.observations.flatMap(toLabValues),
    ),
    priorTreatments: dedupePriorTreatments(
      buckets.procedures
        .map(toPriorTreatment)
        .filter((p): p is PriorTreatment => p !== null),
    ),
  });
}

// ---------- FHIR types (subset) ----------

type Coding = { system?: string; code?: string; display?: string };
type CodeableConcept = { coding?: Coding[]; text?: string };
type FhirResource = { resourceType: string; [k: string]: unknown };
type FhirBundle = {
  resourceType: "Bundle";
  entry?: Array<{ resource: FhirResource }>;
};

type PatientResource = FhirResource & {
  resourceType: "Patient";
  birthDate?: string;
  gender?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
};
type ConditionResource = FhirResource & {
  resourceType: "Condition";
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  verificationStatus?: CodeableConcept;
  onsetDateTime?: string;
  recordedDate?: string;
  abatementDateTime?: string;
};
type MedicationRequestResource = FhirResource & {
  resourceType: "MedicationRequest";
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  authoredOn?: string;
};
type MedicationAdministrationResource = FhirResource & {
  resourceType: "MedicationAdministration";
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  effectiveDateTime?: string;
};
type ObservationComponent = {
  code?: CodeableConcept;
  valueQuantity?: { value?: number; unit?: string };
  valueString?: string;
};
type ObservationResource = FhirResource & {
  resourceType: "Observation";
  status?: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: { value?: number; unit?: string };
  valueString?: string;
  component?: ObservationComponent[];
};
type ProcedureResource = FhirResource & {
  resourceType: "Procedure";
  code?: CodeableConcept;
  status?: string;
  performedDateTime?: string;
  performedPeriod?: { start?: string };
};

type Buckets = {
  patient: PatientResource | undefined;
  conditions: ConditionResource[];
  medicationRequests: MedicationRequestResource[];
  medicationAdministrations: MedicationAdministrationResource[];
  observations: ObservationResource[];
  procedures: ProcedureResource[];
};

// ---------- Constants ----------

const SYSTEM_SNOMED = "http://snomed.info/sct";
const SYSTEM_LOINC = "http://loinc.org";
const SYSTEM_RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";
// Placeholder for Coding entries that omit `system` (malformed FHIR but
// possible from real EHR feeds). Visible downstream so consumers can branch.
const SYSTEM_UNKNOWN = "unknown";

// Observation categories that carry quantitative measurements worth keeping.
// "social-history" intentionally excluded — aligns with social-code filtering.
const OBSERVATION_CATEGORIES = new Set(["laboratory", "vital-signs"]);

// Observation.status values that represent a clinician-validated value.
// Dropped: registered, preliminary, cancelled, entered-in-error, unknown.
const TRUSTED_OBSERVATION_STATUSES = new Set(["final", "amended", "corrected"]);

// FHIR Condition.clinicalStatus values we recognize. (FHIR R4 set.)
const CLINICAL_STATUSES = new Set([
  "active",
  "recurrence",
  "relapse",
  "inactive",
  "remission",
  "resolved",
]);
// Clinical-status values that indicate the condition is currently present.
// Used by dedupe to prefer "still has it" over "had it" entries.
const ACTIVE_CLINICAL_STATUSES = new Set(["active", "recurrence", "relapse"]);

// Drop MedicationRequest / MedicationAdministration events with these
// statuses entirely — they don't represent real prescribing/administration.
// Anything outside both this set and MEDICATION_STATUSES below is also dropped.
const DROP_MEDICATION_STATUSES = new Set([
  "cancelled",
  "entered-in-error",
  "draft",
  "not-done",
  "unknown",
]);
const MEDICATION_STATUSES = new Set([
  "active",
  "in-progress",
  "on-hold",
  "stopped",
  "completed",
]);

// Drop Procedure resources with these statuses — they did not actually occur
// or are invalid.
const DROP_PROCEDURE_STATUSES = new Set([
  "not-done",
  "entered-in-error",
  "unknown",
]);

// SNOMED codes for social/admin findings emitted by Synthea that have no
// clinical-trial-matching value. Kept explicit (not tag-based) because
// `(finding)` and `(situation)` also cover clinically-relevant items like
// "Body mass index 30+ - obesity" and "Past pregnancy history of miscarriage".
const SOCIAL_CONDITION_CODES = new Set<string>([
  // Employment / labor force
  "160903007", // Full-time employment
  "160904001", // Part-time employment
  "73438004", // Unemployed
  "741062008", // Not in labor force
  "1187604002", // Serving in military service
  // Education
  "473461003", // Educated to high school level
  "224295006", // Only received primary school education
  "224299000", // Received higher education
  // Social / violence / isolation
  "422650009", // Social isolation
  "423315002", // Limited social contact
  "424393004", // Reports of violence in the environment
  "706893006", // Victim of intimate partner abuse
  "73595000", // Stress
  // Housing / transport
  "105531004", // Housing unsatisfactory
  "266934004", // Transport problem
  "713458007", // Lack of access to transportation
  // Risk behavior (non-substance)
  "160968000", // Risk activity involvement
  // Administrative
  "314529007", // Medication review due
]);

// ---------- Bucketing ----------

function bucketByType(resources: FhirResource[]): Buckets {
  const buckets: Buckets = {
    patient: undefined,
    conditions: [],
    medicationRequests: [],
    medicationAdministrations: [],
    observations: [],
    procedures: [],
  };
  for (const r of resources) {
    switch (r.resourceType) {
      case "Patient":
        buckets.patient = r as PatientResource;
        break;
      case "Condition":
        buckets.conditions.push(r as ConditionResource);
        break;
      case "MedicationRequest":
        buckets.medicationRequests.push(r as MedicationRequestResource);
        break;
      case "MedicationAdministration":
        buckets.medicationAdministrations.push(r as MedicationAdministrationResource);
        break;
      case "Observation":
        buckets.observations.push(r as ObservationResource);
        break;
      case "Procedure":
        buckets.procedures.push(r as ProcedureResource);
        break;
    }
  }
  return buckets;
}

// ---------- Patient ----------

function ageYears(birthDate: string | undefined, now: Date): number {
  if (!birthDate) return 0;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return 0;
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())
  ) {
    age -= 1;
  }
  return Math.max(0, age);
}

function normalizeSex(g: string | undefined): PatientProfile["sex"] {
  if (g === "male" || g === "female" || g === "other") return g;
  return "unknown";
}

function patientDeceasedStatus(
  p: PatientResource,
): { deceased: boolean; deceasedDate?: string } {
  if (p.deceasedDateTime) {
    return { deceased: true, deceasedDate: p.deceasedDateTime };
  }
  if (p.deceasedBoolean === true) {
    return { deceased: true };
  }
  return { deceased: false };
}

// ---------- Coding selection ----------

function pickCoding(
  concept: CodeableConcept | undefined,
  preferredSystem: string,
): Coding | undefined {
  const codings = concept?.coding ?? [];
  return codings.find((c) => c.system === preferredSystem) ?? codings[0];
}

function displayFor(concept: CodeableConcept | undefined, coding: Coding): string {
  return concept?.text ?? coding.display ?? coding.code ?? "";
}

// ---------- Conditions ----------

function toCondition(r: ConditionResource): Condition | null {
  // Drop differential / refuted / entered-in-error diagnoses. Missing
  // verificationStatus is treated as confirmed (lenient — some sources omit it).
  const verification = r.verificationStatus?.coding?.[0]?.code;
  if (verification && verification !== "confirmed") return null;

  const coding = pickCoding(r.code, SYSTEM_SNOMED);
  if (!coding?.code) return null;
  const statusCode = r.clinicalStatus?.coding?.[0]?.code;
  const clinicalStatus =
    statusCode && CLINICAL_STATUSES.has(statusCode)
      ? (statusCode as Condition["clinicalStatus"])
      : undefined;
  return {
    code: coding.code,
    system: coding.system ?? SYSTEM_UNKNOWN,
    display: displayFor(r.code, coding),
    onsetDate: r.onsetDateTime ?? r.recordedDate,
    abatementDate: r.abatementDateTime,
    clinicalStatus,
  };
}

function dedupeConditions(items: Condition[]): Condition[] {
  return dedupeBy(items, (c) => c.code, (a, b) => {
    const rank = (c: Condition) =>
      c.clinicalStatus && ACTIVE_CLINICAL_STATUSES.has(c.clinicalStatus) ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.onsetDate ?? "").localeCompare(b.onsetDate ?? "");
  });
}

// ---------- Medications ----------
//
// Each MedicationRequest/MedicationAdministration becomes an `RxEvent`.
// Events for the same RxNorm code are grouped into a single `Medication`,
// with events sorted oldest → newest. No gap-based episode inference: any
// downstream consumer that needs episodes can apply a class-appropriate
// threshold to `events`. See module doc for rationale.

type RxEvent = {
  code: string;
  system: string;
  display: string;
  event: MedicationEvent;
};

function toMedicationEvent(
  r: MedicationRequestResource | MedicationAdministrationResource,
  kind: "request" | "administration",
): RxEvent | null {
  // Drop events that don't represent real prescribing/administration:
  // cancelled, entered-in-error, draft (MedRequest), not-done (MedAdmin),
  // unknown.
  if (r.status && DROP_MEDICATION_STATUSES.has(r.status)) return null;

  const coding = pickCoding(r.medicationCodeableConcept, SYSTEM_RXNORM);
  if (!coding?.code) return null;
  const date =
    kind === "request"
      ? (r as MedicationRequestResource).authoredOn
      : (r as MedicationAdministrationResource).effectiveDateTime;
  if (!date) return null;
  // Normalize the FHIR status (which differs between MedicationRequest and
  // MedicationAdministration) into our common 5-value enum.
  const status =
    r.status && MEDICATION_STATUSES.has(r.status)
      ? (r.status as MedicationEvent["status"])
      : undefined;
  return {
    code: coding.code,
    system: coding.system ?? SYSTEM_UNKNOWN,
    display: displayFor(r.medicationCodeableConcept, coding),
    event: { date, status },
  };
}

function groupMedicationEvents(items: RxEvent[]): Medication[] {
  const map = new Map<string, Medication>();
  for (const item of items) {
    const existing = map.get(item.code);
    if (existing) {
      existing.events.push(item.event);
    } else {
      map.set(item.code, {
        code: item.code,
        system: item.system,
        display: item.display,
        events: [item.event],
      });
    }
  }
  for (const med of map.values()) {
    med.events.sort((a, b) => a.date.localeCompare(b.date));
  }
  return Array.from(map.values());
}

// ---------- Labs (incl. vital-sign observations) ----------
//
// Each measurement becomes an `LabPoint`. Component-bearing observations
// (e.g. BP panels) emit one point per component under that component's
// LOINC code. Points are grouped by LOINC into a `Lab` series sorted
// oldest → newest. Same rationale as Medications: preserves trend signal
// (HbA1c < 7% for ≥ 6 months, declining tumor markers, etc.) without
// imposing aggregation choices at the boundary.

type LabPoint = {
  code: string;
  system: string;
  display: string;
  labValue: LabValue;
};

function isUsefulObservation(r: ObservationResource): boolean {
  // Keep clinician-validated observations only: final, amended, corrected.
  // Missing status is treated as trusted (lenient — some sources omit it).
  if (r.status && !TRUSTED_OBSERVATION_STATUSES.has(r.status)) return false;
  return (
    r.category?.some((c) =>
      c.coding?.some((co) => co.code && OBSERVATION_CATEGORIES.has(co.code)),
    ) ?? false
  );
}

function toLabValues(r: ObservationResource): LabPoint[] {
  if (!isUsefulObservation(r)) return [];
  const date = r.effectiveDateTime ?? r.issued;
  if (!date) return [];

  const fromComponents = (r.component ?? [])
    .map((comp) => {
      const coding = pickCoding(comp.code, SYSTEM_LOINC);
      if (!coding?.code) return null;
      const value = comp.valueQuantity?.value ?? comp.valueString;
      if (value === undefined) return null;
      const point: LabPoint = {
        code: coding.code,
        system: coding.system ?? SYSTEM_UNKNOWN,
        display: displayFor(comp.code, coding),
        labValue: { date, value, unit: comp.valueQuantity?.unit },
      };
      return point;
    })
    .filter((p): p is LabPoint => p !== null);

  if (fromComponents.length > 0) return fromComponents;

  const coding = pickCoding(r.code, SYSTEM_LOINC);
  if (!coding?.code) return [];
  const value = r.valueQuantity?.value ?? r.valueString;
  if (value === undefined) return [];
  return [
    {
      code: coding.code,
      system: coding.system ?? SYSTEM_UNKNOWN,
      display: displayFor(r.code, coding),
      labValue: { date, value, unit: r.valueQuantity?.unit },
    },
  ];
}

function groupLabValues(points: LabPoint[]): Lab[] {
  const map = new Map<string, Lab>();
  for (const p of points) {
    const existing = map.get(p.code);
    if (existing) {
      existing.values.push(p.labValue);
    } else {
      map.set(p.code, {
        code: p.code,
        system: p.system,
        display: p.display,
        values: [p.labValue],
      });
    }
  }
  for (const lab of map.values()) {
    lab.values.sort((a, b) => a.date.localeCompare(b.date));
  }
  return Array.from(map.values());
}

// ---------- Prior treatments (Procedures) ----------

function toPriorTreatment(r: ProcedureResource): PriorTreatment | null {
  // Drop procedures that didn't actually occur or are invalidated:
  // not-done, entered-in-error, unknown. Other statuses (completed,
  // in-progress, on-hold, stopped, preparation) pass through.
  if (r.status && DROP_PROCEDURE_STATUSES.has(r.status)) return null;

  const coding = pickCoding(r.code, SYSTEM_SNOMED);
  if (!coding?.code) return null;
  return {
    code: coding.code,
    system: coding.system ?? SYSTEM_UNKNOWN,
    display: displayFor(r.code, coding),
    date: r.performedDateTime ?? r.performedPeriod?.start,
  };
}

function dedupePriorTreatments(items: PriorTreatment[]): PriorTreatment[] {
  return dedupeBy(items, (p) => p.code, (a, b) =>
    (a.date ?? "").localeCompare(b.date ?? ""),
  );
}

// ---------- Generic dedup ----------

// `compare(incoming, existing)` returns >0 if incoming should replace existing.
function dedupeBy<T>(
  items: T[],
  key: (t: T) => string,
  compare: (a: T, b: T) => number,
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (!existing || compare(item, existing) > 0) {
      map.set(k, item);
    }
  }
  return Array.from(map.values());
}
