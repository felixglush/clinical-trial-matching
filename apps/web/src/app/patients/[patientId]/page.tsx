import { Button } from "@/components/ui/button";
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
        <Button>Run new match</Button>
      </div>
      <MatchHistoryList patientId={patientId} />
    </div>
  );
}
