import { describe, expect, it } from "vitest";

import {
  PATIENT_FIXTURES,
  PatientProfileSchema,
  type PatientFixture,
} from "@clinical-trial-matching/shared";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPatientProfile,
  extractPatientProfile,
} from "./extract-patient-profile.js";
import { AgentState } from "../state.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BUNDLES_DIR = join(REPO_ROOT, "data", "synthea-output", "fhir");
const NOW = new Date("2026-05-20T00:00:00Z");

const FIXTURE: PatientFixture = {
  slug: "test-patient",
  uuid: "00000000-0000-0000-0000-000000000000",
  displayName: "Test Patient",
  archetype: "Synthetic",
};

function bundle(resources: unknown[]) {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: resources.map((resource) => ({ resource })),
  };
}

function patient(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "Patient",
    birthDate: "1980-01-01",
    gender: "female",
    ...overrides,
  };
}

async function loadFixtureBundle(uuid: string): Promise<unknown> {
  const files = await readdir(BUNDLES_DIR);
  const file = files.find((f) => f.endsWith(`${uuid}.json`));
  if (!file) throw new Error(`No bundle for ${uuid}`);
  return JSON.parse(await readFile(join(BUNDLES_DIR, file), "utf-8"));
}

// ----- Pure builder: synthetic bundles -----

describe("buildPatientProfile (synthetic)", () => {
  it("computes age from birthDate using provided 'now'", () => {
    const p = buildPatientProfile(
      bundle([patient({ birthDate: "1980-06-01" })]),
      FIXTURE,
      new Date("2026-05-20T00:00:00Z"),
    );
    // Birthday hasn't happened yet in 2026 → age 45.
    expect(p.ageYears).toBe(45);
  });

  it("normalizes unknown gender to 'unknown'", () => {
    const p = buildPatientProfile(
      bundle([patient({ gender: "intersex" })]),
      FIXTURE,
      NOW,
    );
    expect(p.sex).toBe("unknown");
  });

  it("marks living patients as not deceased", () => {
    const p = buildPatientProfile(bundle([patient()]), FIXTURE, NOW);
    expect(p.deceased).toBe(false);
    expect(p.deceasedDate).toBeUndefined();
  });

  it("captures deceasedDateTime", () => {
    const p = buildPatientProfile(
      bundle([patient({ deceasedDateTime: "2007-07-03T13:29:45Z" })]),
      FIXTURE,
      NOW,
    );
    expect(p.deceased).toBe(true);
    expect(p.deceasedDate).toBe("2007-07-03T13:29:45Z");
  });

  it("captures deceasedBoolean without date", () => {
    const p = buildPatientProfile(
      bundle([patient({ deceasedBoolean: true })]),
      FIXTURE,
      NOW,
    );
    expect(p.deceased).toBe(true);
    expect(p.deceasedDate).toBeUndefined();
  });

  it("drops conditions whose verificationStatus is not confirmed", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          ...condition("254837009", "Malignant neoplasm of breast (disorder)", "active"),
          verificationStatus: { coding: [{ code: "differential" }] },
        },
        {
          ...condition("44054006", "Diabetes mellitus type 2 (disorder)", "active"),
          verificationStatus: { coding: [{ code: "confirmed" }] },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions.map((c) => c.code)).toEqual(["44054006"]);
  });

  it("keeps conditions with missing verificationStatus (lenient)", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        condition("254837009", "Malignant neoplasm of breast (disorder)", "active"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions).toHaveLength(1);
  });

  it.each(["recurrence", "relapse"])(
    "maps Condition.clinicalStatus=%s through to the schema",
    (status) => {
      const p = buildPatientProfile(
        bundle([
          patient(),
          condition("254837009", "Malignant neoplasm of breast (disorder)", status),
        ]),
        FIXTURE,
        NOW,
      );
      expect(p.conditions[0]?.clinicalStatus).toBe(status);
    },
  );

  it("dedupe treats recurrence/relapse as active for condition ranking", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          ...condition("254837009", "Malignant neoplasm of breast (disorder)", "resolved"),
          onsetDateTime: "2020-01-01",
        },
        {
          ...condition("254837009", "Malignant neoplasm of breast (disorder)", "relapse"),
          onsetDateTime: "2019-01-01", // older but relapse beats resolved
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions[0]?.clinicalStatus).toBe("relapse");
  });

  it.each(["cancelled", "entered-in-error", "draft", "unknown"])(
    "drops MedicationRequest with status=%s",
    (status) => {
      const p = buildPatientProfile(
        bundle([
          patient(),
          medicationRequest("metformin-rx", status, "2024-01-01"),
        ]),
        FIXTURE,
        NOW,
      );
      expect(p.medications).toEqual([]);
    },
  );

  it("keeps MedicationAdministration status=in-progress and normalizes it", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        medicationAdministration("rx-chemo", "in-progress", "2024-03-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.medications).toHaveLength(1);
    expect(p.medications[0]?.events[0]?.status).toBe("in-progress");
  });

  it("keeps MedicationRequest status=on-hold and normalizes it", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        medicationRequest("rx-pred", "on-hold", "2024-03-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.medications[0]?.events[0]?.status).toBe("on-hold");
  });

  it.each(["not-done", "entered-in-error", "unknown"])(
    "drops Procedure with status=%s",
    (status) => {
      const p = buildPatientProfile(
        bundle([
          patient(),
          {
            resourceType: "Procedure",
            status,
            code: {
              coding: [{ system: "http://snomed.info/sct", code: "392021009" }],
              text: "Lumpectomy of breast (procedure)",
            },
            performedPeriod: { start: "2022-05-01T10:00:00Z" },
          },
        ]),
        FIXTURE,
        NOW,
      );
      expect(p.priorTreatments).toEqual([]);
    },
  );

  it("captures Condition.abatementDateTime", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          ...condition("444814009", "Viral sinusitis (disorder)", "resolved"),
          abatementDateTime: "2020-03-15T00:00:00Z",
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions[0]?.abatementDate).toBe("2020-03-15T00:00:00Z");
    expect(p.conditions[0]?.clinicalStatus).toBe("resolved");
  });

  it("excludes social condition codes via denylist", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        // Social: Stress
        condition("73595000", "Stress (finding)", "active"),
        // Social: Social isolation
        condition("422650009", "Social isolation (finding)", "active"),
        // Clinical disorder
        condition("254837009", "Malignant neoplasm of breast (disorder)", "active"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions.map((c) => c.code)).toEqual(["254837009"]);
  });

  it("retains clinically-relevant (finding) codes (BMI obesity, prediabetes)", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        condition("162864005", "Body mass index 30+ - obesity (finding)", "active"),
        condition("714628002", "Prediabetes (finding)", "active"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions.map((c) => c.code).sort()).toEqual([
      "162864005",
      "714628002",
    ]);
  });

  it("prefers SNOMED coding when multiple coding systems are present", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Condition",
          code: {
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10", code: "I10", display: "Hypertension (ICD-10)" },
              { system: "http://snomed.info/sct", code: "59621000", display: "Essential hypertension (disorder)" },
            ],
            text: "Essential hypertension (disorder)",
          },
          clinicalStatus: { coding: [{ code: "active" }] },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions[0]?.code).toBe("59621000");
  });

  it("groups events for the same RxNorm into one Medication, sorted oldest → newest", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        medicationRequest("metformin-rx", "active", "2020-01-01"),
        medicationRequest("metformin-rx", "stopped", "2021-06-01"),
        medicationRequest("metformin-rx", "active", "2023-03-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.medications).toHaveLength(1);
    expect(p.medications[0]?.events.map((e) => e.date)).toEqual([
      "2020-01-01",
      "2021-06-01",
      "2023-03-01",
    ]);
    expect(p.medications[0]?.events.map((e) => e.status)).toEqual([
      "active",
      "stopped",
      "active",
    ]);
  });

  it("preserves start/stop/restart sequence even when events arrive out of order", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        medicationRequest("metformin-rx", "active", "2023-03-01"),
        medicationRequest("metformin-rx", "active", "2020-01-01"),
        medicationRequest("metformin-rx", "stopped", "2021-06-01"),
      ]),
      FIXTURE,
      NOW,
    );
    // "Currently on metformin?" → last event must be 'active' at 2023-03-01.
    const events = p.medications[0]?.events ?? [];
    expect(events[events.length - 1]).toEqual({
      date: "2023-03-01",
      status: "active",
    });
  });

  it("merges MedicationRequest and MedicationAdministration events under the same RxNorm", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        medicationRequest("metformin-rx", "active", "2024-01-01"),
        medicationAdministration("metformin-rx", "completed", "2024-02-15"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.medications).toHaveLength(1);
    expect(p.medications[0]?.events).toHaveLength(2);
  });

  it("drops medication events with no date (cannot be sequenced)", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "MedicationRequest",
          status: "active",
          // authoredOn omitted on purpose
          medicationCodeableConcept: {
            coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "rx-no-date" }],
          },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.medications).toEqual([]);
  });

  it("unfolds component observations (blood pressure) into separate labs", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Observation",
          status: "final",
          category: [{ coding: [{ code: "vital-signs" }] }],
          code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
          effectiveDateTime: "2024-03-01",
          component: [
            {
              code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
              valueQuantity: { value: 121, unit: "mm[Hg]" },
            },
            {
              code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] },
              valueQuantity: { value: 74, unit: "mm[Hg]" },
            },
          ],
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.labs.map((l) => l.code).sort()).toEqual(["8462-4", "8480-6"]);
    expect(p.labs.every((l) => l.values[0]?.date === "2024-03-01")).toBe(true);
  });

  it("drops observations with neither value nor components", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Observation",
          status: "final",
          category: [{ coding: [{ code: "laboratory" }] }],
          code: { coding: [{ system: "http://loinc.org", code: "2093-3" }] },
          effectiveDateTime: "2024-03-01",
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.labs).toEqual([]);
  });

  it("groups lab values by LOINC into a chronological series", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        labObservation("2093-3", 180, "2020-01-01"),
        labObservation("2093-3", 220, "2024-06-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.labs).toHaveLength(1);
    expect(p.labs[0]?.values).toEqual([
      { date: "2020-01-01", value: 180, unit: "mg/dL" },
      { date: "2024-06-01", value: 220, unit: "mg/dL" },
    ]);
  });

  it("preserves lab sequence even when observations arrive out of order", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        labObservation("2093-3", 220, "2024-06-01"),
        labObservation("2093-3", 180, "2020-01-01"),
        labObservation("2093-3", 200, "2022-01-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.labs[0]?.values.map((v) => v.date)).toEqual([
      "2020-01-01",
      "2022-01-01",
      "2024-06-01",
    ]);
  });

  it.each(["registered", "preliminary", "cancelled", "entered-in-error"])(
    "drops observations with status=%s",
    (status) => {
      const p = buildPatientProfile(
        bundle([
          patient(),
          {
            resourceType: "Observation",
            status,
            category: [{ coding: [{ code: "laboratory" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "2093-3" }] },
            effectiveDateTime: "2024-03-01",
            valueQuantity: { value: 187, unit: "mg/dL" },
          },
        ]),
        FIXTURE,
        NOW,
      );
      expect(p.labs).toEqual([]);
    },
  );

  it.each(["final", "amended", "corrected"])(
    "keeps observations with status=%s (clinician-validated)",
    (status) => {
      const p = buildPatientProfile(
        bundle([
          patient(),
          {
            resourceType: "Observation",
            status,
            category: [{ coding: [{ code: "laboratory" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "2093-3" }] },
            effectiveDateTime: "2024-03-01",
            valueQuantity: { value: 187, unit: "mg/dL" },
          },
        ]),
        FIXTURE,
        NOW,
      );
      expect(p.labs).toHaveLength(1);
    },
  );

  it("includes observations with missing status (lenient)", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Observation",
          category: [{ coding: [{ code: "laboratory" }] }],
          code: { coding: [{ system: "http://loinc.org", code: "2093-3" }] },
          effectiveDateTime: "2024-03-01",
          valueQuantity: { value: 187, unit: "mg/dL" },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.labs).toHaveLength(1);
  });

  it("produces structured priorTreatments from Procedures", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Procedure",
          status: "completed",
          code: {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: "392021009",
                display: "Lumpectomy of breast (procedure)",
              },
            ],
            text: "Lumpectomy of breast (procedure)",
          },
          performedPeriod: { start: "2022-05-01T10:00:00Z" },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.priorTreatments).toEqual([
      {
        code: "392021009",
        system: "http://snomed.info/sct",
        display: "Lumpectomy of breast (procedure)",
        date: "2022-05-01T10:00:00Z",
      },
    ]);
  });

  it("records the coding system on each item", () => {
    const p = buildPatientProfile(
      bundle([
        patient(),
        condition("254837009", "Malignant neoplasm of breast (disorder)", "active"),
        medicationRequest("metformin-rx", "active", "2024-01-01"),
        labObservation("2093-3", 180, "2024-01-01"),
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions[0]?.system).toBe("http://snomed.info/sct");
    expect(p.medications[0]?.system).toBe("http://www.nlm.nih.gov/research/umls/rxnorm");
    expect(p.labs[0]?.system).toBe("http://loinc.org");
  });

  it("falls back to coding[0] system when preferred system absent", () => {
    // Condition coded only in ICD-10 — no SNOMED coding present.
    const p = buildPatientProfile(
      bundle([
        patient(),
        {
          resourceType: "Condition",
          code: {
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10", code: "I10", display: "Hypertension" },
            ],
            text: "Hypertension",
          },
          clinicalStatus: { coding: [{ code: "active" }] },
        },
      ]),
      FIXTURE,
      NOW,
    );
    expect(p.conditions).toHaveLength(1);
    expect(p.conditions[0]?.code).toBe("I10");
    expect(p.conditions[0]?.system).toBe("http://hl7.org/fhir/sid/icd-10");
  });

  it("throws when bundle has no Patient resource", () => {
    expect(() => buildPatientProfile(bundle([]), FIXTURE, NOW)).toThrow(
      /no Patient resource/,
    );
  });

  it("throws when input is not a FHIR Bundle", () => {
    expect(() => buildPatientProfile({ foo: "bar" }, FIXTURE, NOW)).toThrow(
      /not a FHIR Bundle/,
    );
  });
});

// ----- Node wrapper -----

describe("extractPatientProfile (node)", () => {
  it("returns an error for unknown patientId without touching disk", async () => {
    const result = await extractPatientProfile({
      ...emptyState(),
      patientId: "does-not-exist",
    });
    expect(result.error).toMatch(/Unknown patient/);
    expect(result.patientProfile).toBeUndefined();
  });
});

// ----- Integration: real Synthea bundles -----

describe("buildPatientProfile against real fixtures", () => {
  it.each(PATIENT_FIXTURES.map((f) => [f.slug, f]))(
    "parses %s into a valid PatientProfile",
    async (_slug, fixture) => {
      const b = await loadFixtureBundle(fixture.uuid);
      const profile = buildPatientProfile(b, fixture, NOW);
      // Schema parse already happened inside; assert it round-trips.
      expect(() => PatientProfileSchema.parse(profile)).not.toThrow();
      expect(profile.id).toBe(fixture.slug);
      expect(profile.displayName).toBe(fixture.displayName);
      // No social codes should leak through.
      for (const denied of [
        "73595000", // Stress
        "422650009", // Social isolation
        "160903007", // Full-time employment
        "473461003", // Educated to high school level
      ]) {
        expect(profile.conditions.find((c) => c.code === denied)).toBeUndefined();
      }
    },
  );

  it("includes the archetype condition for hedy-sauer (breast cancer)", async () => {
    const fixture = PATIENT_FIXTURES.find((f) => f.slug === "hedy-sauer")!;
    const profile = buildPatientProfile(
      await loadFixtureBundle(fixture.uuid),
      fixture,
      NOW,
    );
    expect(
      profile.conditions.find((c) => c.code === "254837009"),
    ).toBeDefined();
  });

  it("flags brady-schmidt as deceased (real fixture data)", async () => {
    const fixture = PATIENT_FIXTURES.find((f) => f.slug === "brady-schmidt")!;
    const profile = buildPatientProfile(
      await loadFixtureBundle(fixture.uuid),
      fixture,
      NOW,
    );
    expect(profile.deceased).toBe(true);
    expect(profile.deceasedDate).toBeDefined();
  });
});

// ----- Helpers for synthetic resources -----

function condition(code: string, display: string, status: string) {
  return {
    resourceType: "Condition",
    code: {
      coding: [{ system: "http://snomed.info/sct", code, display }],
      text: display,
    },
    clinicalStatus: { coding: [{ code: status }] },
  };
}

function medicationRequest(code: string, status: string, authoredOn: string) {
  return {
    resourceType: "MedicationRequest",
    status,
    authoredOn,
    medicationCodeableConcept: {
      coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code }],
    },
  };
}

function medicationAdministration(code: string, status: string, effectiveDateTime: string) {
  return {
    resourceType: "MedicationAdministration",
    status,
    effectiveDateTime,
    medicationCodeableConcept: {
      coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code }],
    },
  };
}

function labObservation(code: string, value: number, date: string) {
  return {
    resourceType: "Observation",
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { coding: [{ system: "http://loinc.org", code }] },
    effectiveDateTime: date,
    valueQuantity: { value, unit: "mg/dL" },
  };
}

function emptyState() {
  return {
    patientId: "",
    patientProfile: null,
    mechanisms: [],
    mechanismDrops: [],
    repurposingCandidates: [],
    searchStrategy: null,
    candidates: [],
    candidateDrops: [],
    matches: [],
    attempts: 0,
    approvalRequest: null,
    error: null,
  } satisfies typeof AgentState.State;
}
