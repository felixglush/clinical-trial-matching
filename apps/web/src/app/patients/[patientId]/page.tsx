import { RunNewMatchButton } from "@/components/run-new-match-button";
import { MatchHistoryList } from "@/components/match-history-list";

export default async function PatientPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  return (
    <div className="space-y-6">
      <div>
        <RunNewMatchButton patientId={patientId} />
      </div>
      <MatchHistoryList patientId={patientId} />
    </div>
  );
}
