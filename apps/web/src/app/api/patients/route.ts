import { NextResponse } from "next/server";
import { listPatients } from "@/lib/patient-loader";

export async function GET() {
  const patients = await listPatients();
  return NextResponse.json({ patients });
}
