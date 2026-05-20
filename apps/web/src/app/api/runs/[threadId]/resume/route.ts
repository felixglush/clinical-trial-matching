import { NextResponse } from "next/server";
import { GRAPH_ID, langgraph } from "@/lib/langgraph";
import type { ApprovalResponse } from "@/lib/types";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const body = (await req.json()) as ApprovalResponse;
  const run = await langgraph.runs.create(threadId, GRAPH_ID, {
    command: { resume: body },
  });
  return NextResponse.json({ runId: run.run_id });
}
