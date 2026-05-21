import "server-only";
import {
  PATIENT_FIXTURES,
  type PatientFixture,
} from "@clinical-trial-matching/shared";

export async function listPatients(): Promise<Array<{ id: string; displayName: string }>> {
  return PATIENT_FIXTURES.map(({ slug, displayName }) => ({
    id: slug,
    displayName,
  }));
}

// Returns the fixture metadata for the patient detail page. The full
// PatientProfile (with FHIR-derived conditions/labs/meds) only exists inside
// the agent's state — the web detail page just needs slug, displayName, and
// archetype to render the header and trigger a run.
export async function getPatient(patientId: string): Promise<PatientFixture | null> {
  return PATIENT_FIXTURES.find((p) => p.slug === patientId) ?? null;
}
