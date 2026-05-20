import type { PatientProfile } from "@/lib/types";

export function PatientHeader({ patient }: { patient: PatientProfile }) {
  return (
    <header className="border-b border-neutral-200 pb-4 mb-6">
      <h1 className="text-2xl font-semibold">{patient.displayName}</h1>
      <p className="text-sm text-neutral-500">
        {patient.ageYears}y · {patient.sex}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {patient.conditions.map((c) => (
          <span
            key={c.code}
            className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs"
          >
            {c.display}
          </span>
        ))}
      </div>
    </header>
  );
}
