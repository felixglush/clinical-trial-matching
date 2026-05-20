import type { PatientProfile } from "@clinical-trial-matching/shared";

export async function loadPatientBundle(_patientId: string): Promise<unknown> {
  throw new Error("loadPatientBundle not implemented");
}

export async function loadPatientProfile(_patientId: string): Promise<PatientProfile> {
  throw new Error("loadPatientProfile not implemented");
}
