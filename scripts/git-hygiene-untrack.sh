#!/usr/bin/env bash
set -euo pipefail

# Safely removes runtime databases, ML telemetry mirrors, Python caches, and AI Studio
# artifacts from Git index tracking WITHOUT deleting local files on disk.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git rm -r --cached --ignore-unmatch \
    quant_ledger.duckdb.sqlite \
    ml_telemetry_ledger_mirror.json \
    kalshi_brier_calibration.sqlite \
    __pycache__ \
    .aistudio \
    "src/services/firestoreSyncService 2.ts" \
    "firebase-applet-config 2.json"
  echo "[repo-hygiene] Untracked runtime ledgers, caches, and duplicate files from Git index (local files preserved)."
else
  echo "[repo-hygiene] No .git directory detected in current container workspace; run this script in your local git checkout to untrack cached artifacts."
fi
