"use client";

export function ReasoningTrace({ messages: _messages }: { messages: unknown[] }) {
  // TODO: render streamed LLM messages per node, scrollable.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">Reasoning</h3>
      <p className="text-sm text-neutral-500">Live trace will stream here.</p>
    </section>
  );
}
