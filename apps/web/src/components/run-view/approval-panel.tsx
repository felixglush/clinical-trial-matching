"use client";
import { Button } from "@/components/ui/button";
import type { ApprovalRequest } from "@/lib/types";

export function ApprovalPanel({
  request: _request,
  threadId: _threadId,
}: {
  request: ApprovalRequest;
  threadId: string;
}) {
  // TODO: POST to /api/runs/[threadId]/resume on approve/reject/edit.
  return (
    <section className="rounded border border-amber-300 bg-amber-50 p-4">
      <h3 className="font-semibold mb-2">Review matches</h3>
      <p className="text-sm text-neutral-700 mb-3">
        The agent is waiting for your approval.
      </p>
      <div className="flex gap-2">
        <Button>Approve</Button>
        <Button variant="outline">Edit</Button>
        <Button variant="ghost">Reject</Button>
      </div>
    </section>
  );
}
