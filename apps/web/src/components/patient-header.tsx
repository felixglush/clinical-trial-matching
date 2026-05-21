import type { PatientFixture } from "@clinical-trial-matching/shared";

export function PatientHeader({ patient }: { patient: PatientFixture }) {
  return (
    <header className="border-b border-neutral-200 pb-4 mb-6">
      <h1 className="text-2xl font-semibold">{patient.displayName}</h1>
      <p className="text-sm text-neutral-500">{patient.archetype}</p>
    </header>
  );
}
