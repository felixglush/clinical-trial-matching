import { Client } from "@langchain/langgraph-sdk";

const apiUrl = process.env.LANGGRAPH_API_URL;
const apiKey = process.env.LANGGRAPH_API_KEY;

if (!apiUrl) {
  throw new Error("LANGGRAPH_API_URL is not set");
}

export const langgraph = new Client({
  apiUrl,
  apiKey: apiKey || undefined,
});

export const GRAPH_ID = "clinical_trial_matching";
