import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PATIENT_FIXTURES } from "@clinical-trial-matching/shared";

// apps/agent/src/tools/<this> → up 4 = repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BUNDLES_DIR = join(REPO_ROOT, "data", "synthea-output", "fhir");

export async function loadPatientBundle(patientId: string): Promise<unknown> {
  const fixture = PATIENT_FIXTURES.find((f) => f.slug === patientId);
  if (!fixture) {
    throw new Error(`Unknown patient: ${patientId}`);
  }

  const files = await readdir(BUNDLES_DIR).catch(() => {
    throw new Error(
      `Patient bundles not found at ${BUNDLES_DIR}. Run 'pnpm patients:generate'.`,
    );
  });
  const filename = files.find((f) => f.endsWith(`${fixture.uuid}.json`));
  if (!filename) {
    throw new Error(
      `Bundle for ${fixture.slug} (UUID ${fixture.uuid}) not found in ${BUNDLES_DIR}. ` +
        `Run 'pnpm patients:generate'.`,
    );
  }

  const json = await readFile(join(BUNDLES_DIR, filename), "utf-8");
  return JSON.parse(json);
}
