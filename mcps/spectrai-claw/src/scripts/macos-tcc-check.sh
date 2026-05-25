#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "blocked: macOS TCC checks require Darwin; current kernel=$(uname -s)"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_DIR="${ROOT_DIR}/src/swift-helper"

echo "== SpectrAI Claw macOS TCC preflight =="
echo "root: ${ROOT_DIR}"
echo "helper: ${HELPER_DIR}"
echo

echo "1) Build TypeScript and Swift helper"
(
  cd "${ROOT_DIR}"
  npm run build
  cd "${HELPER_DIR}"
  swift build
)
echo

echo "2) Query helper permissions"
(
  cd "${HELPER_DIR}"
  swift run spectrai-claw-helper permissions || true
)
echo

echo "3) Run non-mutating provider smoke when possible"
(
  cd "${ROOT_DIR}"
  node dist/scripts/macos-computer-use-smoke.js || true
)
echo

cat <<'RUNBOOK'
If Accessibility is missing:
  System Settings > Privacy & Security > Accessibility > enable Terminal/iTerm/VS Code/SpectrAI helper, then restart the host process.
If Screen Recording / Screen & System Audio Recording is missing:
  System Settings > Privacy & Security > Screen & System Audio Recording > enable the same host/helper, then restart.
If Automation / Apple Events is missing:
  Trigger an osascript/JXA menu command once, click Allow, then confirm under System Settings > Privacy & Security > Automation.
Blocked status in Windows CI is expected because AXUIElement, TCC prompts, ScreenCaptureKit/CoreGraphics capture, and Apple Events are macOS-only.
RUNBOOK
