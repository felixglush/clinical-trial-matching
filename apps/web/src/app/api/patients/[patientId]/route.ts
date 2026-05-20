import { NextResponse } from "next/server";
import { getPatient } from "@/lib/patients-loader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const patient = await getPatient(patientId);
  if (!patient) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ patient });
}
