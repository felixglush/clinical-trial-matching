#!/usr/bin/env bash
set -euo pipefail

# Loads the filtered PrimeKG subset into a local Neo4j instance.
#
# - Sources apps/agent/.env for NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD.
# - Auto-detects Neo4j Desktop's import dir on macOS (override with NEO4J_IMPORT_DIR).
# - Symlinks data/kg/{nodes,edges}.csv into that import dir so the Cypher
#   script's file:/// paths resolve.
# - Runs cypher-shell from the same DBMS bundle (override with NEO4J_CYPHER_SHELL).
#
# Expect 30–60 minutes for the full ~80K nodes / ~4M edges load.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KG_DIR="${REPO_ROOT}/data/kg"
CYPHER_SCRIPT="${REPO_ROOT}/scripts/load-primekg-to-neo4j.cypher"
ENV_FILE="${REPO_ROOT}/apps/agent/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${NEO4J_URI:?NEO4J_URI not set (e.g., neo4j://localhost:7687) in apps/agent/.env}"
: "${NEO4J_USERNAME:?NEO4J_USERNAME not set in apps/agent/.env}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD not set in apps/agent/.env}"

if [[ ! -f "${KG_DIR}/nodes.csv" || ! -f "${KG_DIR}/edges.csv" ]]; then
  echo "ERROR: ${KG_DIR}/{nodes,edges}.csv missing. Run 'pnpm kg:build-subset' first." >&2
  exit 1
fi

# Auto-detect Neo4j Desktop's import dir (macOS). Single DBMS expected.
if [[ -z "${NEO4J_IMPORT_DIR:-}" ]]; then
  matches=()
  for dir in "${HOME}/Library/Application Support/neo4j-desktop/Application/Data/dbmss/"dbms-*/import; do
    [[ -d "${dir}" ]] && matches+=("${dir}")
  done
  case "${#matches[@]}" in
    0) echo "ERROR: no Neo4j Desktop DBMS found. Set NEO4J_IMPORT_DIR explicitly." >&2; exit 1 ;;
    1) NEO4J_IMPORT_DIR="${matches[0]}" ;;
    *) echo "ERROR: multiple Neo4j Desktop DBMSes found. Set NEO4J_IMPORT_DIR to pick one:" >&2
       printf '  %s\n' "${matches[@]}" >&2; exit 1 ;;
  esac
fi
echo "Using Neo4j import dir: ${NEO4J_IMPORT_DIR}"

# cypher-shell sits next to the import dir in the DBMS bundle.
DBMS_HOME="$(dirname "${NEO4J_IMPORT_DIR}")"
CYPHER_SHELL="${NEO4J_CYPHER_SHELL:-${DBMS_HOME}/bin/cypher-shell}"
if [[ ! -x "${CYPHER_SHELL}" ]]; then
  echo "ERROR: cypher-shell not found at ${CYPHER_SHELL}. Set NEO4J_CYPHER_SHELL." >&2
  exit 1
fi

# cypher-shell is a Java app and needs `java` (21 or 25) on PATH. Prefer a Neo4j-
# supported brew openjdk (keg-only on macOS); fall back to whatever's already on PATH.
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@25; do
    if [[ -d "${candidate}" ]]; then
      export JAVA_HOME="${candidate}"
      export PATH="${JAVA_HOME}/bin:${PATH}"
      break
    fi
  done
fi
if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: Java not found. Install Java 21+ with: brew install openjdk@21" >&2
  exit 1
fi
JAVA_MAJOR="$(java -version 2>&1 | awk -F'[".]' '/version/ {print $2; exit}')"
if [[ -z "${JAVA_MAJOR}" ]] || (( JAVA_MAJOR < 21 )); then
  echo "ERROR: cypher-shell requires Java 21+, found:" >&2
  java -version >&2
  echo "Install with: brew install openjdk@21" >&2
  exit 1
fi

# Symlink CSVs into Neo4j's import dir so file:///nodes.csv resolves.
for f in nodes.csv edges.csv; do
  ln -sf "${KG_DIR}/${f}" "${NEO4J_IMPORT_DIR}/${f}"
done
echo "Symlinked nodes.csv and edges.csv into import dir."

echo "Loading PrimeKG subset (~80K nodes / ~4M edges) — expect 30–60 min…"
"${CYPHER_SHELL}" -a "${NEO4J_URI}" -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" -f "${CYPHER_SCRIPT}"

echo ""
echo "Done. Verify with a sanity query, e.g.:"
echo "  MATCH (n:Node) RETURN n.type, count(*) ORDER BY count(*) DESC;"
