import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getPatient } from "@/lib/patient-loader";
import { PatientHeader } from "@/components/patient-header";

export default async function PatientLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const patient = await getPatient(patientId);
  if (!patient) return notFound();
  return (
    <div>
      <PatientHeader patient={patient} />
      {children}
    </div>
  );
}
