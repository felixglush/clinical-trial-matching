import { defineConfig } from "@playwright/test";

// E2E config. Assumes agent (port 2024) and Neo4j are already running.
// Spawns Next.js dev server for the web app. To run all four patients
// you need the agent + Neo4j up — see README.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 5 * 60 * 1000, // 5 min — LLM + KG calls can be slow
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
