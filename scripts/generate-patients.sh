#!/usr/bin/env bash
set -euo pipefail

# Generates a deterministic 200-patient pool via Synthea into data/synthea-output/.
# The four archetype patients (see packages/shared/src/patient-fixtures.ts) are
# resolved by UUID from this pool by the loaders — no copy step.
#
# Requires Java 11+ and synthea-with-dependencies.jar in data/.
# Re-running with seed=42 produces byte-identical bundles.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${REPO_ROOT}/data"
JAR="${DATA}/synthea-with-dependencies.jar"
OUT="${DATA}/synthea-output"

# Java: prefer PATH; fall back to a keg-only brew openjdk (macOS).
# Synthea works with Java 11+; the KG load also uses Java, so 21 covers both.
if command -v java >/dev/null 2>&1; then
  JAVA=java
else
  for candidate in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@25; do
    if [[ -x "${candidate}/bin/java" ]]; then
      JAVA="${candidate}/bin/java"
      break
    fi
  done
fi
if [[ -z "${JAVA:-}" ]]; then
  echo "ERROR: Java not found. Install with: brew install openjdk@21" >&2
  exit 1
fi

if [[ ! -f "${JAR}" ]]; then
  echo "ERROR: Synthea jar not found at ${JAR}" >&2
  echo "Download synthea-with-dependencies.jar from:" >&2
  echo "  https://github.com/synthetichealth/synthea/releases/latest" >&2
  exit 1
fi

if [[ -d "${OUT}/fhir" ]] && [[ -n "$(ls -A "${OUT}/fhir" 2>/dev/null)" ]]; then
  echo "Synthea output already present at ${OUT}/fhir — nothing to do."
  echo "(Delete ${OUT} to regenerate.)"
  exit 0
fi

echo "Generating 200-patient pool (seed=42, this takes a few minutes)..."
cd "${DATA}"
"${JAVA}" -jar "${JAR}" \
  -s 42 -p 200 -a 30-80 \
  --exporter.fhir.use_us_core_ig true \
  --exporter.baseDirectory ./synthea-output \
  Massachusetts

echo ""
echo "Done. Bundles in ${OUT}/fhir"
echo "Loader will pick the four archetype patients by UUID:"
echo "  hedy-sauer      8af9d5d7-2600-556b-5158-64501509f9f5"
echo "  brady-schmidt   8580a690-4d97-5739-4f07-788ad44e6f04"
echo "  pamela-lesch    6bc4cd5d-0216-17a9-8192-ac2209957d3a"
echo "  marvin-weissnat 4aaa0001-3832-cc52-e2f3-47aad08f4284"
