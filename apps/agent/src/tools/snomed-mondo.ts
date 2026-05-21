// Pure lookup from a SNOMED CT code (as appears on FHIR Condition.code) to the
// PrimeKG disease node it represents. Backed by the committed JSON crosswalk
// built by `pnpm kg:build-crosswalk`. The crosswalk is constructed offline via
// MONDO's SSSOM mappings; see scripts/build-mondo-crosswalk.ts.

import crosswalkData from "../data/snomed-to-primekg.json" with { type: "json" };

export type ResolvedDisease = {
  mondoId: string;
  primekgNodeId: string;
  primekgName: string;
};

const crosswalk = crosswalkData as Record<string, ResolvedDisease>;

export function resolveSnomedCondition(snomedCode: string): ResolvedDisease | null {
  return crosswalk[snomedCode] ?? null;
}
