import { NextResponse } from "next/server";
import { GRAPH_ID, langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const threads = await langgraph.threads.search({
    metadata: { patientId },
    limit: 50,
  });
  return NextResponse.json({ threads });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const thread = await langgraph.threads.create({ metadata: { patientId } });
  const run = await langgraph.runs.create(thread.thread_id, GRAPH_ID, {
    input: { patientId },
  });
  return NextResponse.json({ threadId: thread.thread_id, runId: run.run_id });
}
