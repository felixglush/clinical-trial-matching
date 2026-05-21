"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

export function RunNewMatchButton({ patientId }: { patientId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}/runs`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`Failed to start run: ${res.status} ${res.statusText}`);
      }
      const { threadId } = (await res.json()) as { threadId: string };
      router.push(`/patients/${patientId}/runs/${threadId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={handleClick} disabled={pending} data-testid="run-new-match">
        {pending ? "Starting…" : "Run new match"}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
