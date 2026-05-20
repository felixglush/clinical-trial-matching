import type { AgentStateType } from "../state.js";

export async function extractPatientProfile(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: load FHIR bundle for state.patientId, call LLM with extractProfilePrompt,
  // validate with PatientProfileSchema, return { patientProfile }
  return { patientProfile: null };
}
