import "server-only";
import type { PatientProfile } from "@clinical-trial-matching/shared";

export async function listPatients(): Promise<Array<{ id: string; displayName: string }>> {
  // TODO: read data/patients/*.json, return id + displayName for each.
  return [];
}

export async function getPatient(_patientId: string): Promise<PatientProfile | null> {
  // TODO: read data/patients/<id>.json, parse with PatientProfileSchema.
  return null;
}
