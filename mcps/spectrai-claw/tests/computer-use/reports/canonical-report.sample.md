# Computer Use Benchmark Canonical Report

- schemaVersion: computer-use-benchmark-report/v1
- generatedAt: 2026-05-25T06:33:54.244Z
- fixture: sample simulated runtime observations for canonical report
- platform: cross-platform-fixture
- node: node-test-compatible

## Case counts

| total | eligible | passed | failed | skipped | unsupported |
|---:|---:|---:|---:|---:|---:|
| 6 | 4 | 4 | 0 | 1 | 1 |

## Required metrics

| metric | numerator/denominator | rate |
|---|---:|---:|
| semanticActionSuccessRate | 9/10 | 90.0% |
| backgroundActionSuccessRate | 9/10 | 90.0% |
| foregroundFallbackRate | 2/12 | 16.7% |
| visionFallbackRate | 2/12 | 16.7% |
| hidFallbackRate | 1/12 | 8.3% |
| postActionVerificationSuccessRate | 7/7 | 100.0% |

## Additional capability metrics

| metric | numerator/denominator | rate |
|---|---:|---:|
| providerAvailabilityRate | 4/6 | 66.7% |
| semanticTreeCoverage | 58/62 | 93.5% |
| selectorHitRate | 11/12 | 91.7% |
| elementActionSuccessRate | 11/12 | 91.7% |
| backgroundReadSuccessRate | 3/4 | 75.0% |
| backgroundInvokeSuccessRate | 4/4 | 100.0% |
| backgroundInputSuccessRate | 2/2 | 100.0% |
| fallbackRate | 2/12 | 16.7% |
| misClickIncidentRate | 0/12 | 0.0% |

- latency: avg 118.2ms / p50 55ms / p95 820ms / max 820ms
- permissionBlockers: macOS Accessibility permission required for AX tree/actions; macOS Screen Recording permission required when vision fallback is exercised

## Case matrix

| id | platform | status | provider | mode | background | foreground fallback | vision fallback | HID fallback | semantic coverage | selector hit | action success | latency |
|---|---|---|---|---|---|---|---|---|---:|---:|---:|---|
| win32-native-controls | windows | passed | windows-uia | uia_only | yes | no | no | no | 92.9% | 100.0% | 100.0% | avg 51.3ms / p50 47ms / p95 61ms / max 61ms |
| chrome-baidu-search | browser | passed | browser-cdp | dom_selector | yes | no | no | no | 100.0% | 100.0% | 100.0% | avg 47.7ms / p50 34ms / p95 81ms / max 81ms |
| electron-spectrai-controls | cross-platform | skipped | electron-adapter | uia-or-ax-or-cdp | no | no | no | no | n/a | n/a | n/a | n/a |
| macos-ax-demo | macos | unsupported | macos-ax | ax_only | no | no | no | no | n/a | n/a | n/a | n/a |
| vision-hid-fallback-canvas | browser | passed | vision-hid-fallback | vision_then_hid | yes | yes | yes | yes | 50.0% | 66.7% | 66.7% | avg 311.3ms / p50 95ms / p95 820ms / max 820ms |
| windows-legacy-claw-accuracy-compat | windows | passed | windows-claw-compat | legacy_mcp_tools_semantic_first | yes | no | no | no | 85.7% | 100.0% | 100.0% | avg 68ms / p50 66ms / p95 70ms / max 70ms |

## Provider availability

| case | platform | provider | mode | available | reason |
|---|---|---|---|---|---|
| win32-native-controls | windows | windows-uia | uia_only | yes |  |
| chrome-baidu-search | browser | browser-cdp | dom_selector | yes |  |
| electron-spectrai-controls | cross-platform | electron-adapter | uia-or-ax-or-cdp | no | sample app not running |
| macos-ax-demo | macos | macos-ax | ax_only | no | non-macOS fixture environment |
| vision-hid-fallback-canvas | browser | vision-hid-fallback | vision_then_hid | yes |  |
| windows-legacy-claw-accuracy-compat | windows | windows-claw-compat | legacy_mcp_tools_semantic_first | yes |  |

## Regression gates

- semanticActionSuccessRate: >= 0.9 (eligible non-fallback cases)
- postActionVerificationSuccessRate: >= 0.95 (actions requiring verification)
- misClickIncidentRate: <= 0 (all eligible actions)
- hidFallbackRate: <= 0.15 (all eligible actions except explicit fallback category)

## Risks

- Real provider adapters are still owned by Core/Windows/macOS/Browser agents; this fixture only defines the report contract and deterministic smoke path.
- Online Baidu validation may be blocked by network, bot protection or locale changes; local HTML fixture should be used for deterministic CI.
- macOS AX validation depends on user-granted Accessibility and Screen Recording permissions; unsupported/skip must be reported rather than failed.
- Canvas fallback is intentionally foreground/HID based and should not be used to justify regressions in semantic-capable cases.

## Next round recommendations

- Wire provider teams' real observation adapters into this schema and keep this sample fixture as a golden smoke test.
- Add per-provider latency budgets once Windows UIA, macOS AX and Browser CDP implementations stabilize.
- Split fallback gates by category so explicit fallback scenarios can pass while native/browser semantic scenarios keep low HID/Vision rates.
- Publish report artifacts from CI for trend comparison across runtime builds.

