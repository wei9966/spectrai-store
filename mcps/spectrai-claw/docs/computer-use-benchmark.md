# Computer Use Runtime Benchmark and Post-merge Acceptance Report

This document defines the minimum benchmark, canonical report shape, and post-merge acceptance matrix for the Universal Computer Use Runtime work in `spectrai-claw`.

The focus is to verify that the runtime is not only a paper architecture:

`target app -> state/control tree/DOM/AX/UIA -> selector -> semantic action -> capability report -> vision/OCR/HID fallback only when needed -> post-action verification`

## Files

- `tests/computer-use/scenarios/canonical-scenarios.json` — canonical scenario definitions.
- `tests/computer-use/reports/canonical-report.sample.json` — canonical report fixture and metric source.
- `tests/computer-use/reports/provider-integration-acceptance.json` — provider acceptance gates, risk thresholds, and post-merge retest order.
- `reports/post-merge-acceptance-report.json` — final Reviewer Pool entry report with provider status, command, log path, evidence, and residual risk.
- `tests/computer-use/reports/post-merge-acceptance-report.json` — detailed canonical current round provider evidence matrix, commands, logs, and remaining risks.
- `tests/computer-use/fixtures/browser/baidu-search-fixture.html` — local DOM fixture for Browser/CDP selector/type/submit verification.
- `tests/computer-use/fixtures/browser/canvas-fallback-fixture.html` — canvas-only fixture for vision/OCR/HID fallback verification.
- `tests/computer-use/fixtures/macos/ax-demo.applescript` — macOS AX manual demo script.
- `tests/computer-use/run-computer-use-benchmark.mjs` — fixture validator and metric derivation runner.
- `tests/e2e/computer-use-benchmark.test.mjs` — `node:test` smoke test wired into the e2e folder.

## Canonical scenarios

| ID | Provider line | Purpose | Expected path |
| --- | --- | --- | --- |
| `win-notepad-uia-type` | Windows provider | Native Notepad text entry | UIA `ValuePattern.SetValue` + value verification |
| `win-calculator-uia-invoke` | Windows provider | Native Calculator button invoke | UIA `InvokePattern.Invoke` + display/state verification |
| `browser-baidu-dom-search` | Browser provider | Local Baidu-like DOM search | CDP/DOM selector + value/submit + DOM verification |
| `electron-spectrai-uia-command` | Windows/Electron bridge | Weak UIA Electron content | UIA first, OCR neighborhood evidence, foreground type only with reason |
| `macos-ax-demo-button` | macOS provider | AX button/menu action | AX semantic action or explicit unsupported/TCC blocked path |
| `fallback-canvas-vision-ocr-hid` | Fallback layer | Canvas-only target | semantic provider miss -> vision/OCR target -> HID final fallback + verification |

## Required metrics

All metrics are derived by `tests/computer-use/run-computer-use-benchmark.mjs` from `canonical-report.sample.json`.

| Metric | Definition |
| --- | --- |
| `semanticActionSuccessRate` | Passed semantic cases with `afterVerification.success=true` divided by semantic cases. |
| `backgroundActionSuccessRate` | Passed background-capable invoke/type cases divided by background-capable cases. |
| `backgroundReadCoverageRate` | Cases whose capability reports `backgroundRead=true` divided by all cases. |
| `backgroundInvokeCoverageRate` | Cases whose capability reports `backgroundInvoke=true` divided by all cases. |
| `backgroundTypeCoverageRate` | Cases whose capability reports `backgroundType=true` divided by all cases. |
| `foregroundFallbackRate` | Cases requiring foreground divided by all cases. |
| `visionFallbackRate` | Cases needing vision/OCR fallback divided by all cases. |
| `hidFallbackRate` | Cases needing HID fallback divided by all cases. |
| `postActionVerificationSuccessRate` | Cases whose `afterVerification.success=true` divided by all cases. |
| `averageVerificationConfidence` | Average `afterVerification.confidence` across all cases. |
| `wrongClickRiskWeightedScore` | Risk-weighted score derived from risk/fallback flags; lower is better. |
| `fallbackTraceabilityRate` | Fallback cases whose every fallback entry has `type`, `reason`, and `traceId`. |

The mission-critical metric subset is: `semanticActionSuccessRate`, `backgroundActionSuccessRate`, `foregroundFallbackRate`, `visionFallbackRate`, `hidFallbackRate`, and `postActionVerificationSuccessRate`.

## Canonical report format

A live provider run must emit the same top-level shape as `reports/canonical-report.sample.json`:

```json
{
  "schemaVersion": "computer-use-benchmark.report.v0",
  "run": {
    "id": "unique-run-id",
    "mode": "fixture-only | live",
    "runtimeVersion": "git sha or package version",
    "host": { "platform": "windows | darwin | linux", "note": "environment details" }
  },
  "metrics": {
    "semanticActionSuccessRate": 0,
    "backgroundActionSuccessRate": 0,
    "foregroundFallbackRate": 0,
    "visionFallbackRate": 0,
    "hidFallbackRate": 0,
    "postActionVerificationSuccessRate": 0
  },
  "cases": [
    {
      "scenario": "browser-baidu-dom-search",
      "provider": "browser-dom-cdp",
      "providerLine": "browser-provider",
      "status": "passed | failed | blocked | unsupported-in-env",
      "selector": { "strategy": "css", "value": "input[name=wd]" },
      "action": { "type": "typeAndSubmit", "semantic": true, "background": true, "method": "DOM.value + requestSubmit" },
      "capability": {
        "backgroundRead": true,
        "backgroundInvoke": true,
        "backgroundType": true,
        "requiresForeground": false,
        "visionFallbackNeeded": false,
        "hidFallbackNeeded": false
      },
      "beforeVerification": { "source": "dom", "targetFound": true, "confidence": 1 },
      "afterVerification": { "source": "dom", "success": true, "confidence": 0.99, "evidence": "DOM state changed" },
      "fallbackUsed": [],
      "riskFlags": [],
      "evidence": { "command": "...", "logPath": "..." },
      "pass": true,
      "reason": "State was verified after the action."
    }
  ]
}
```

Every fallback entry must include:

```json
{ "type": "visionOcr | hid | provider-specific", "reason": "why fallback was necessary", "traceId": "stable evidence id" }
```

Dispatch alone is not success. A case can be counted as successful only when post-action verification succeeds, or when it is an explicitly marked unsupported safe path for the current environment.

## Running the benchmark

From `mcps/spectrai-claw`:

```bash
node tests/computer-use/run-computer-use-benchmark.mjs
node --test tests/e2e/computer-use-benchmark.test.mjs
node --test "tests/e2e/*.mjs"
```

### Current local results in this worktree

Host: Windows worktree `worktree/agent-7dcd576e`.

```text
node tests/computer-use/run-computer-use-benchmark.mjs
ok=true; scenarioCount=6; caseCount=6; providerAcceptanceCount=5; postMergeProviderLineCount=6; all thresholdResults=true
```

Key metrics:

```json
{
  "semanticActionSuccessRate": 0.8,
  "backgroundActionSuccessRate": 0.75,
  "backgroundReadCoverageRate": 0.8333,
  "backgroundInvokeCoverageRate": 0.5,
  "backgroundTypeCoverageRate": 0.3333,
  "foregroundFallbackRate": 0.3333,
  "visionFallbackRate": 0.3333,
  "hidFallbackRate": 0.1667,
  "postActionVerificationSuccessRate": 0.8333,
  "averageVerificationConfidence": 0.725,
  "wrongClickRiskWeightedScore": 0.3,
  "fallbackTraceabilityRate": 1
}
```

```text
node --test tests/e2e/computer-use-benchmark.test.mjs
pass=1; fail=0
```

```text
node --test "tests/e2e/*.mjs"
pass=1; skipped=11 macOS-only; fail=0
```

Build note:

```text
npm run build
blocked-environment: npx tsc failed because this worktree has no local TypeScript dependency; npm ls typescript --depth=0 returned empty.
```

The benchmark runner/e2e path is therefore verified independently. TypeScript build should be rerun after dependencies are installed or in the integration worktree used by provider owners.

## Post-merge provider acceptance matrix

The detailed machine-readable matrix is `tests/computer-use/reports/post-merge-acceptance-report.json`.

| Provider line | Current status | Evidence | Commands/log paths | Remaining risk |
| --- | --- | --- | --- | --- |
| Core runtime | `accepted-composition-smoke-semi-real` | Baseline accepted in task `8b3d1f02-086d-4f03-91cb-514f588979f5`, commit `0cb9583`; reported `npx tsc --noEmit`, `npm run build`, and runtime tests passed. Supplemental task `506f0042-a09e-439e-8982-0b892dc8f55f`, commit `f7ee147`, added stub-based post-merge smoke harness. Round-2 task `4544db19-f27f-456d-a060-08aff8b6fabb` was accepted after rework in commit `14ea52d`: `npx tsc --noEmit` and `npm run smoke:computer-use` passed, and the smoke generated `%TEMP%\\spectrai-claw-computer-use-composition-smoke.jsonl` with Browser CDP blocked probe, Windows legacy bridge read/dry-run verification, macOS unsupported/TCC, and vision fallback contract. | Accepted review summary for task `4544db19-f27f-456d-a060-08aff8b6fabb`; JSONL path `%TEMP%\\spectrai-claw-computer-use-composition-smoke.jsonl`. | Accepted but semi-real: Browser live CDP still needs 9222, Core's own Windows leg uses legacy read/dry-run, Agent B now supplies separate WinForms mutate proof, and macOS live AX still requires macOS/TCC. |
| Windows provider | `passed-mutate-smoke-winforms-fixture` | Baseline accepted in task `e8a3ffdf-0540-487b-bfb4-8a712c6a406b`, commit `e25366b`; review recorded real Windows smoke `provider=windows-uia-win32`, `supportsUia=true`, `supportsWin32Semantic=true`, `windowCount=32`. Supplemental task `66b000f6-067e-4a2b-90a5-f019cb972655`, commit `a8f2e9a`, added Notepad/Calculator/Explorer validation assets and read-only smoke evidence. Round-2 task `cb39b95b-b0fc-4956-a577-af44ef6dc4cd`, commit `48ec8be`, passed WinForms fixture mutate smoke: window/tree read, selector, Value/Invoke/Selection actions, post-action assertions, and UIA-first/Win32 fallback codes. | Commands: `npm run build`, `node scripts/windows-provider-smoke.mjs`, `node --test tests/e2e/windows-provider-smoke.test.mjs`; artifact `C:\Users\魏斌\AppData\Local\Temp\spectrai-claw-windows-provider-smoke-22a391ad.json`. | Passed for real/semi-real WinForms fixture. Remaining risk: broader Notepad/Calculator/Explorer live-app mutation, localized selectors, DPI/RDP/session boundaries, and strict `verification_failed` behavior. |
| Browser provider | `blocked-live-cdp-fake-session-passed` | Baseline accepted in task `009cfa43-a940-4e9a-9c85-3542741ffac6`, commit `87f2ac9`; build/tsc/browser-provider smoke reported passed. Supplemental task `f6d8ea1e-174b-4962-92d3-cde1319b4cf0`, commit `72bd05d`, added fake-session capability report assertions and evidence doc. Fake-session tests passed for capability report, DOM state/tree, selector/action, and verification. Live CDP probe blocked: `/json/version` timed out; live smoke `SMOKE_EXIT=2`, `error fetch failed`. | Evidence doc `mcps/spectrai-claw/docs/computer-use-browser-smoke-evidence-2026-05-25.md`; task summaries `f1bb0522` and `f6d8ea1e`; Chrome debug command: `chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\\spectrai-cdp-smoke`. | Need real Chrome/Edge debug port 9222 reachable before live DOM snapshot/click/type verification can pass. |
| macOS provider | `accepted-contract-static-live-unsupported` | Baseline accepted in task `6cbb6ec6-1f49-4157-bd00-64a132ce0c1a`, commit `0c07264`; Windows-safe smoke returned unsupported-platform. Supplemental task `781fb434-9d1a-45be-9cae-bee9567789fd`, commit `d345adf`, added TCC runbook, verify script, JXA JSON smoke entry and QA fixture. Round-2 task `b154cfaf-36cb-4008-b768-ba66c0d6d440` accepted after rework: `node --test dist/computer-use/providers/macos/__tests__/provider-contract.test.js` 5 pass with fake bridge/ProviderRegistry-like composition. | Accepted review summary for task `b154cfaf-36cb-4008-b768-ba66c0d6d440`; local manual fixture: `osascript tests/computer-use/fixtures/macos/ax-demo.applescript` on macOS. | Requires macOS host and Accessibility/Automation/Screen Recording permission for real AX; contract/static path passed but live AX remains unsupported in this Windows worktree. |
| Fallback layer | `passed-fixture-live-fallback-blocked-by-provider-results` | Fixture report has Electron OCR-neighborhood and canvas vision/OCR/HID fallback with `type/reason/traceId`; `fallbackTraceabilityRate=1`. | Local runner stdout; Windows mutate now contributes WinForms fixture fallback codes, while live fallback proof still needs Browser live CDP and broader real provider miss reasons. | Need real provider miss reason before fallback and post-action screenshot/state evidence for HID; fixture is accepted only as schema/traceability proof. |
| Benchmark package | `passed-local-fixture` | Current Agent E run: runner passed; e2e smoke passed; explicit e2e glob passed with expected macOS skips. | stdout from commands above. | Fixture report must be replaced or supplemented by live report after A/B/C/D integration. |

## Browser live CDP smoke runbook

When Browser provider is present in an integration worktree:

1. Launch Chrome/Edge with a debugging port and isolated profile.
   - Windows example:
     ```powershell
     Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$env:TEMP\spectrai-cdp-smoke"
     ```
2. Open the local fixture:
   ```text
   file:///ABSOLUTE/PATH/mcps/spectrai-claw/tests/computer-use/fixtures/browser/baidu-search-fixture.html
   ```
3. Run the Browser provider live smoke from Agent D's task output.
4. Required evidence in canonical report:
   - provider: Browser DOM/CDP provider id;
   - capability: `backgroundRead=true`, `backgroundInvoke=true`, `backgroundType=true`, `requiresForeground=false`;
   - selector: `input[name=wd]` or equivalent accessible-name selector;
   - action: semantic `typeAndSubmit` or `setValue` + submit;
   - after verification: input value and result text changed;
   - no `visionFallbackNeeded` or `hidFallbackNeeded` for DOM-backed fixture.

If CDP/Chrome is unavailable, mark the case `blocked` and include the failed launch command, stderr, and the fixture-only substitute result.

## Windows mutate smoke runbook

When Windows provider is present in an integration worktree:

1. Launch Notepad and Calculator or use the provider owner smoke fixture.
2. Execute Notepad type case:
   - selector: `automationId=15`, `controlType=Edit`, localized name fallback allowed;
   - action: `ValuePattern.SetValue` preferred;
   - verification: UIA value/text contains the requested string.
3. Execute Calculator invoke case:
   - selector: `automationId=num7Button`, `controlType=Button`, localized name fallback allowed;
   - action: `InvokePattern.Invoke` preferred;
   - verification: result/display changes to include `7`.
4. If fallback triggers, report:
   - failed UIA/Win32 reason;
   - whether foreground was required;
   - whether OCR was only neighborhood evidence;
   - whether HID was final fallback;
   - post-action verification evidence path.

Existing Windows Claw accuracy path should still be checked with existing MCP/e2e commands when available: `describe_screen`, `click_element`, `type_text`/keyboard typing, `uia_find_element`, and `uia_get_tree` must keep returning compatible results. This benchmark does not modify provider implementation files.

## macOS AX contract and TCC runbook

Current Windows environment cannot execute true macOS AX. On macOS:

1. Grant permissions to the terminal/runtime binary:
   - System Settings > Privacy & Security > Accessibility;
   - Automation for controlling target apps;
   - Screen Recording if visual fallback evidence is captured;
   - Input Monitoring only if HID fallback is exercised.
2. Run:
   ```bash
   osascript tests/computer-use/fixtures/macos/ax-demo.applescript
   ```
3. Run the macOS provider contract/static tests from Agent C's task output.
4. Required evidence:
   - capability report includes permission state and background capability flags;
   - selector includes AX role/title/identifier/pid/window where available;
   - unsupported path is explicit when permission is absent;
   - AX action success requires AX state/value/window-tree verification.

## Interpretation rules

- `passed` means real provider action or fixture action has post-action verification evidence.
- `baseline-passed-*` means first-round accepted provider evidence exists, but round-2 live composition evidence is still pending.
- `blocked` means environment or missing provider source prevented live execution; blocked rows must include a command or exact missing precondition.
- `unsupported-in-current-windows-env` is valid only for macOS AX in this Windows worktree.
- HID fallback is acceptable only as a final fallback with traceable target evidence and post-action verification.

## Remaining risks and next recommendations

1. Core composition is `accepted-composition-smoke-semi-real`: commit `14ea52d` provides reproducible smoke and JSONL evidence, but the remaining integration risk is replacing Browser blocked probe, Windows legacy read/dry-run bridge, and macOS unsupported/TCC contract with real provider constructors when those environments are available.
2. Windows mutate is `passed-mutate-smoke-winforms-fixture`: task `cb39b95b` / commit `48ec8be` passed `npm run build`, `node scripts/windows-provider-smoke.mjs`, and `node --test tests/e2e/windows-provider-smoke.test.mjs` with artifact `C:\Users\魏斌\AppData\Local\Temp\spectrai-claw-windows-provider-smoke-22a391ad.json`; remaining risk is broader Notepad/Calculator/Explorer live-app mutation and localized/DPI/RDP/session edge cases.
3. Browser live CDP is `blocked-live-cdp-fake-session-passed`: fake-session substitute passed, but live validation needs Chrome/Edge reachable at `http://127.0.0.1:9222/json/version` after launching with `--remote-debugging-port=9222`.
4. macOS AX is `accepted-contract-static-live-unsupported`: contract/static fake bridge tests passed, but real AX needs a macOS host with Accessibility, Automation, and Screen Recording permissions.
5. Replace fixture-only evidence with a live `computer-use-benchmark.report.v0` file when Core/Windows/Browser/macOS can be composed in one integration worktree; keep the same metric names, provider/capability fields, verification fields, and fallback traceability fields.
