import { NextResponse } from "next/server";
import { listPatients } from "@/lib/patients-loader";

export async function GET() {
  const patients = await listPatients();
  return NextResponse.json({ patients });
}
