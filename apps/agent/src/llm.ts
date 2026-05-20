import { ChatOpenAI } from "@langchain/openai";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}

export const llm = new ChatOpenAI({
  model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5",
  temperature: 0,
  maxRetries: 2,
  apiKey,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      // Optional but recommended — used by OpenRouter for analytics + dashboard.
      "HTTP-Referer": "https://github.com/felixglush/clinical-trial-matching",
      "X-Title": "Clinical Trial Matching",
    },
  },
});
