import { GRAPH_ID, langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of langgraph.runs.stream(threadId, GRAPH_ID, {
          streamMode: ["values", "updates", "messages"],
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
