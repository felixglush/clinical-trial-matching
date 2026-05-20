#!/usr/bin/env bash
set -euo pipefail

# Generates synthetic FHIR patient bundles using Synthea and copies them to data/patients/.
# Requires Java 11+.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTHEA_DIR="${REPO_ROOT}/.synthea"
OUT_DIR="${REPO_ROOT}/data/patients"
N_PATIENTS="${1:-10}"

if ! command -v java >/dev/null 2>&1; then
  echo "Error: Java is not installed. Install Java 11+ first." >&2
  exit 1
fi

if [ ! -d "${SYNTHEA_DIR}" ]; then
  echo "Cloning Synthea..."
  git clone --depth 1 https://github.com/synthetichealth/synthea.git "${SYNTHEA_DIR}"
fi

cd "${SYNTHEA_DIR}"
./run_synthea -p "${N_PATIENTS}"

mkdir -p "${OUT_DIR}"
cp "${SYNTHEA_DIR}"/output/fhir/*.json "${OUT_DIR}/"

echo "Generated ${N_PATIENTS} patients into ${OUT_DIR}"
