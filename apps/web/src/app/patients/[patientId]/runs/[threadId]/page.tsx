import { RunView } from "@/components/run-view";

export default async function RunPage({
  params,
}: {
  params: Promise<{ patientId: string; threadId: string }>;
}) {
  const { threadId } = await params;
  return <RunView threadId={threadId} />;
}
