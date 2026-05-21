import Link from "next/link";
import { listPatients } from "@/lib/patient-loader";

export async function PatientSidebar() {
  const patients = await listPatients();
  return (
    <aside className="w-64 border-r border-neutral-200 p-4">
      <h2 className="text-sm font-semibold uppercase text-neutral-500 mb-2">Patients</h2>
      <ul className="space-y-1">
        {patients.length === 0 && (
          <li className="text-sm text-neutral-400">No patients yet.</li>
        )}
        {patients.map((p) => (
          <li key={p.id}>
            <Link
              href={`/patients/${p.id}`}
              className="block rounded px-2 py-1 text-sm hover:bg-neutral-100"
            >
              {p.displayName}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
