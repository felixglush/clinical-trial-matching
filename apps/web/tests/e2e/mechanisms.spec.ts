import { expect, test } from "@playwright/test";

// Verifies that each of the 4 archetype patients renders at least one
// mechanism in the MechanismsPanel after a new run is triggered. The test
// drives the real agent (LangGraph dev server) + real Neo4j + real LLM —
// keep timeouts generous; the LLM call can take 5-15s typically and
// occasionally far longer (we saw 16 min once via Bedrock backoff).
//
// Prereqs (run separately, see README):
//   - pnpm --filter agent dev    (langgraph dev on :2024)
//   - Neo4j Desktop running, PrimeKG loaded
//   - OPENROUTER_API_KEY in apps/agent/.env

const PATIENT_SLUGS = [
  "hedy-sauer",
  "brady-schmidt",
  "pamela-lesch",
  "marvin-weissnat",
] as const;

for (const slug of PATIENT_SLUGS) {
  test(`patient ${slug} surfaces at least one mechanism`, async ({ page }) => {
    await page.goto(`/patients/${slug}`);

    const runButton = page.getByTestId("run-new-match");
    await expect(runButton).toBeVisible();
    await runButton.click();

    // Button transition triggers a navigation to /patients/[slug]/runs/[id].
    await page.waitForURL(new RegExp(`/patients/${slug}/runs/[^/]+$`), {
      timeout: 30_000,
    });

    // Empty-state copy disappears as soon as the first mechanism arrives.
    const panel = page.getByTestId("mechanisms-panel");
    await expect(panel).toBeVisible();
    const list = panel.getByTestId("mechanisms-list");
    await expect(list).toBeVisible({ timeout: 4 * 60 * 1000 });

    // At least one card with a non-empty rationale.
    const cards = panel.getByTestId("mechanism-card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    const firstRationale = await panel
      .getByTestId("mechanism-rationale")
      .first()
      .textContent();
    expect((firstRationale ?? "").trim().length).toBeGreaterThan(10);
  });
}
