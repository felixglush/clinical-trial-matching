import { NextResponse } from "next/server";
import { langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const history = await langgraph.threads.getHistory(threadId);
  return NextResponse.json({ history });
}
