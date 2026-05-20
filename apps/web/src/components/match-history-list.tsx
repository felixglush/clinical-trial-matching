export function MatchHistoryList({ patientId: _patientId }: { patientId: string }) {
  // TODO: fetch threads from /api/patients/[patientId]/runs, render list.
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Match history</h2>
      <p className="text-sm text-neutral-500">No prior runs.</p>
    </section>
  );
}
