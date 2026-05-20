import { interrupt } from "@langchain/langgraph";
import type { ApprovalResponse } from "@clinical-trial-matching/shared";
import type { AgentStateType } from "../state.js";

export async function humanApproval(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const response = interrupt<typeof state.approvalRequest, ApprovalResponse>(
    state.approvalRequest,
  );

  if (response.action === "reject") {
    return { matches: [], error: response.notes ?? "rejected by reviewer" };
  }

  if (response.action === "edit" && response.edits) {
    return { matches: response.edits };
  }

  return {};
}
