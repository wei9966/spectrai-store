#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
macos-ax-prototype.sh <command> [args]

Commands:
  list-apps
  window-state <process-name>
  ax-tree <process-name> [max-depth]
  press <process-name> <selector-json>
  set-value <process-name> <selector-json> <text>
  select-menu <process-name> <menu-json-array>

Examples:
  src/scripts/macos-ax-prototype.sh list-apps
  src/scripts/macos-ax-prototype.sh window-state Finder
  src/scripts/macos-ax-prototype.sh ax-tree TextEdit 5
  src/scripts/macos-ax-prototype.sh press TextEdit '{"AXTitle":"Save","AXRole":"AXButton"}'
  src/scripts/macos-ax-prototype.sh set-value TextEdit '{"AXRole":"AXTextArea"}' 'hello from SpectrAI'
  src/scripts/macos-ax-prototype.sh select-menu Finder '["File","New Finder Window"]'
USAGE
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "blocked: macOS AX prototypes require Darwin; current kernel=$(uname -s)"
  exit 2
fi

COMMAND="${1:-}"
if [[ -z "${COMMAND}" || "${COMMAND}" == "-h" || "${COMMAND}" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JXA_SCRIPT="${ROOT_DIR}/src/scripts/macos-ax-smoke.jxa"

run_jxa() {
  osascript -l JavaScript "${JXA_SCRIPT}" "$@"
}

run_verify() {
  (
    cd "${ROOT_DIR}"
    if [[ ! -f dist/scripts/macos-computer-use-verify.js ]]; then
      npm run build
    fi
    node dist/scripts/macos-computer-use-verify.js "$@"
  )
}

case "${COMMAND}" in
  list-apps)
    run_jxa --op listApps
    ;;
  window-state)
    process_name="${1:?process-name is required}"
    run_jxa --op windowState --processName "${process_name}"
    ;;
  ax-tree)
    process_name="${1:?process-name is required}"
    max_depth="${2:-5}"
    run_verify --processName "${process_name}" --max-depth "${max_depth}" --max-count 120
    ;;
  press)
    process_name="${1:?process-name is required}"
    selector_json="${2:?selector-json is required}"
    run_verify --processName "${process_name}" --run-actions --press-selector-json "${selector_json}"
    ;;
  set-value)
    process_name="${1:?process-name is required}"
    selector_json="${2:?selector-json is required}"
    text="${3:?text is required}"
    run_verify --processName "${process_name}" --run-actions --setvalue-selector-json "${selector_json}" --text "${text}"
    ;;
  select-menu)
    process_name="${1:?process-name is required}"
    menu_json="${2:?menu-json-array is required}"
    run_jxa --op selectMenu --processName "${process_name}" --menuPath "${menu_json}"
    ;;
  *)
    echo "unknown command: ${COMMAND}"
    usage
    exit 64
    ;;
esac
