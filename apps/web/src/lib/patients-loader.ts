import "server-only";
import {
  PATIENT_FIXTURES,
  type PatientProfile,
} from "@clinical-trial-matching/shared";

export async function listPatients(): Promise<Array<{ id: string; displayName: string }>> {
  return PATIENT_FIXTURES.map(({ slug, displayName }) => ({
    id: slug,
    displayName,
  }));
}

export async function getPatient(_patientId: string): Promise<PatientProfile | null> {
  // TODO: load FHIR bundle from data/synthea-output/ and parse with PatientProfileSchema.
  return null;
}
