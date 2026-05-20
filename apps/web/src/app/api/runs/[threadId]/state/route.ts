import { NextResponse } from "next/server";
import { langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const state = await langgraph.threads.getState(threadId);
  return NextResponse.json({ state });
}
