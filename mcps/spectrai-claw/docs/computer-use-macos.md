# macOS Accessibility Provider for Universal Computer Use Runtime

This document describes the macOS Accessibility provider skeleton added under `src/computer-use/providers/macos/`. It is intentionally independent from the Windows and Browser providers and wraps the existing SpectrAI Claw Swift daemon where possible.

## Goal

Move macOS control from pure screenshot-number clicking toward this pipeline:

`target App/window -> AX tree/state -> selector -> semantic action -> post-action verification -> vision/HID fallback when AX is insufficient`

The design mirrors the behavior users see in Codex Mac Computer Use: a background-capable semantic layer first, with visual/HID fallback only when the OS/app does not expose enough semantic state.

## Files

- `src/computer-use/providers/macos/types.ts` — provider-local schema for apps, windows, AX selectors, ElementNode, actions, capability reports, and verification.
- `src/computer-use/providers/macos/capabilities.ts` — capability and permission mapping, including background/foreground/fallback boundaries.
- `src/computer-use/providers/macos/ax-selector.ts` — `DetectedElement` to unified `ElementNode` mapping and selector matching.
- `src/computer-use/providers/macos/jxa-adapter.ts` — safe Node bridge to `osascript -l JavaScript`; returns unsupported on non-macOS.
- `src/computer-use/providers/macos/provider.ts` — runnable provider skeleton with `listApps`, `listWindows`, `readTree`, `findElement`, `executeAction`, `getCapabilityReport`.
- `src/computer-use/providers/macos/index.ts` — thin export entry.
- `src/scripts/macos-computer-use-smoke.ts` — cross-platform smoke script; non-macOS validates safe unsupported loading.
- `src/scripts/macos-ax-smoke.jxa` — JXA prototype for `listApps`, `windowState`, `press`, `setValue`, and `selectMenu`.

## Implementation path

### Layer 1: TypeScript provider skeleton

`MacOSAccessibilityProvider` exposes:

- `listApps()`
- `listWindows(selector)`
- `readTree(selector, options)`
- `findElement(selector, options)`
- `executeAction(action)`
- `getCapabilityReport()`

On `process.platform !== 'darwin'`, all runtime operations return `unsupported` with a capability report instead of importing or invoking macOS-only APIs. This makes the provider loadable in Windows CI and in the current non-macOS worktree.

### Layer 2: Existing Swift daemon bridge

The provider reuses existing daemon operations:

- `permissionsStatus`
- `listApplications`
- `listWindows`
- `detectElements`
- `getSnapshot`
- `click`
- `type`
- `activateApplication`
- `focusWindow`

The current Swift daemon already attempts native AX actions first for `click`/`type`:

- `click(snapshotId, elementId)` -> `NativeAXActionService.press` with `AXPress`, falling back to HID click.
- `type(snapshotId, elementId)` -> `NativeAXActionService.setValue` with `AXValue`, falling back to focus/click + CGEvent typing.

The provider surfaces the daemon method as canonical action metadata: `daemon.axPress`, `daemon.axSetValue`, `daemon.hidClick`, or `daemon.hidType`.

### Layer 3: JXA/osascript prototype

`macos-ax-smoke.jxa` is a portable prototype for System Events UI scripting:

```bash
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op listApps
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op windowState --processName Finder
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op selectMenu --processName Finder --menuPath '["File","New Finder Window"]'
```

JXA is not the long-term high-confidence path for background actions. It is useful for prototyping menu selection and validating TCC/Automation prompts. Long-term background reliability should move menu and element focus actions into the signed Swift helper.

## AX selector schema

`MacOSAXSelector` supports these fields:

```ts
{
  app?: { bundleId?: string; processName?: string; pid?: number }
  bundleId?: string
  processName?: string
  pid?: number
  windowId?: number
  windowTitle?: string
  AXRole?: string
  role?: string
  AXIdentifier?: string
  identifier?: string
  AXTitle?: string
  title?: string
  AXDescription?: string
  description?: string
  label?: string
  value?: string
  path?: number[] | string
  bounds?: { x?: number; y?: number; width?: number; height?: number; tolerance?: number }
}
```

Matching behavior:

- `bundleId`, `processName`, `pid` narrow the target application.
- `windowId`, `windowTitle` narrow the target window.
- `AXRole`/`role` and `AXIdentifier`/`identifier` are exact normalized matches.
- `AXTitle`, `AXDescription`, `label`, and `value` use normalized contains matching.
- `path` matches the child-index path from `AXUIElementCreateApplication(pid)` to the element.
- `bounds` matches with a default tolerance of 8 points.

## AX tree to ElementNode mapping

The Swift daemon emits `DetectedElement`. The provider maps it to a provider-neutral node shape:

| Swift/AX field | ElementNode field | Notes |
| --- | --- | --- |
| `id` | `id` | Snapshot-local id such as `ax_1`. |
| `role` | `role` and selector `AXRole` | Raw AX role, e.g. `AXButton`. |
| `subrole` | `subrole` | Raw AX subrole when exposed. |
| `label` | `label` | Derived from title/description/value by Swift scanner. |
| `title` | `title` and selector `AXTitle` | AXTitle. |
| `value` | `value` | AXValue when readable. |
| `description` | `description` and selector `AXDescription` | AXDescription. |
| `identifier` | `identifier` and selector `AXIdentifier` | AXIdentifier. |
| `keyboardShortcut` | `keyboardShortcut` | Reserved for menu/button shortcuts. |
| `bounds` | `bounds` | Screen coordinates in macOS points. |
| `isEnabled` | `enabled` | AXEnabled defaulted by scanner. |
| `isActionable` | `actionable` | Role-based actionability heuristic. |
| `parentId` | `parentId` | Used to rebuild tree. |
| `axPath` | `path` and selector `path` | Stable-enough child-index path for same snapshot; validated before native AX action. |

The provider returns both `elements` (tree roots) and `flatElements` for selector matching.

## Actions and verification

### `focus`

Implementation:

- `focusWindow(windowId)` when a window id is available.
- `activateApplication(pid|bundleId)` otherwise.

Boundary: always foreground-affecting. It cannot satisfy `requireBackground`.

Verification:

- Reread `listWindows` and check `isFrontmost` for the target pid/window when possible.

### `press` / `invoke`

Implementation:

1. Resolve `snapshotId + elementId`, or run `findElement(selector)`.
2. Call daemon `click(snapshotId, elementId, left, single)`.
3. Daemon tries `AXPress` using `axPath`; if unsupported/stale, falls back to HID click.

Boundary:

- Background-capable when method is `daemon.axPress`.
- Foreground-dependent when method is `daemon.hidClick`.

Verification:

- Reread AX tree and ensure the target still resolves, or treat target disappearance after press as success for destructive/opening actions.
- If AX state cannot prove success, caller should request visual fallback snapshot.

### `setValue` / `type`

Implementation:

1. Resolve element by snapshot or selector if provided.
2. Call daemon `type` with text and optional `clearExisting`.
3. Daemon tries `AXSetValue`; if unsupported/stale, it clicks/focuses then sends CGEvent typing.

Boundary:

- Background-capable when method is `daemon.axSetValue`.
- Foreground-dependent when method is `daemon.hidType` or when no AX element target is supplied.

Verification:

- Reread element value/label from AX tree.
- For `setValue`/`clearExisting`, observed value must equal expected text.
- For append typing, observed value may contain expected text.

### `select` / `menu` / `selectMenu`

Implementation:

- Element select without `menuPath` reuses press/invoke.
- Menu path select uses JXA/System Events prototype: `osascript -l JavaScript macos-ax-smoke.jxa --op selectMenu`.

Boundary:

- Usually requires target app/menu bar foreground and Automation permission.
- Not considered background-safe.

Verification:

- JXA success only proves System Events accepted the click.
- Use follow-up AX tree, window state, or visual snapshot for app-specific state.

## Capability report

`getCapabilityReport()` returns:

- `backgroundRead`
- `backgroundInvoke`
- `backgroundType`
- `requiresForeground`
- `visionFallbackNeeded`
- `permissionsRequired`
- per-operation capability notes

Important interpretation:

- `backgroundRead=true` means AX/NSWorkspace/CGWindow can read many non-frontmost apps with permissions.
- `backgroundInvoke=true` means AXPress can work without activation on controls that expose `kAXPressAction`.
- `backgroundType=true` means AXSetValue can work without activation on settable text controls.
- `requiresForeground=true` applies to focus, HID fallback, menu-bar automation, hover/materialization, and many custom controls.
- `visionFallbackNeeded=true` means the semantic provider cannot prove or reach the target from AX alone.

## Permissions and TCC boundaries

### Accessibility

Required for:

- `AXUIElement` tree reads.
- `AXPress`, `AXSetValue`, `AXFocused`, window raise/focus.
- CGEvent HID fallback in most real deployments.
- System Events UI scripting.

Grant to the signed helper app/binary or to the terminal/runtime that launches it. On macOS, permissions attach to the executable identity; unsigned scripts and changing build paths can cause repeated prompts.

### Screen Recording

Required for:

- ScreenCaptureKit / CGWindow image capture.
- Vision/OCR fallback.
- Annotated screenshot verification.

AX reads may work without Screen Recording, but visual fallback and screenshot-based post-action verification will not.

### Automation

Required for:

- `osascript`/JXA controlling `System Events`.
- System Events controlling another app's UI process.
- Menu-bar selection prototype.

Automation is per controlling app and target app. It may prompt lazily on first control attempt and is difficult to preflight reliably from Node.

### Sandboxing, signing, notarization

- A sandboxed helper needs the correct accessibility usage description and may still be blocked from broad UI control depending on entitlements and distribution model.
- A stable signed helper is strongly preferred because TCC permissions are tied to code identity.
- Local development from changing `swift run` build paths may require regranting permissions.
- Future helper should expose explicit IPC ops for `axFocus`, `axSelectMenu`, `axReadAttribute`, and `axParameterizedAttribute` instead of relying on JXA for production.

## Background capability boundaries

Can usually stay background:

- List running apps via `NSWorkspace`.
- List windows via `CGWindowList`.
- Read AX tree by pid/window when Accessibility is granted.
- `AXPress` on standard buttons/menu items exposing `kAXPressAction`.
- `AXSetValue` on settable text controls.

Usually requires foreground:

- App/window focus.
- HID click/type/scroll fallback.
- Menu-bar selection through System Events/JXA.
- Controls that only create children after focus, hover, or expansion.
- Secure text fields and custom editors.

Needs vision/OCR fallback:

- Canvas/custom-rendered UI.
- Games/graphics apps without AX nodes.
- Electron/WebView apps with sparse AX and no Browser/CDP provider connection.
- Post-action verification when AX exposes no changed value/selection.

## Relationship to Codex Mac Computer Use behavior

The observed Codex Computer Use experience appears to combine semantic app state with a visual fallback loop. This provider can replicate the main mechanism:

1. Target app/window by bundle/process/window title.
2. Read Accessibility tree into semantic nodes.
3. Select an element by role/title/identifier/path/bounds instead of by screenshot number.
4. Execute AXPress/AXSetValue when possible, preserving background capability.
5. Re-read AX state to verify success.
6. Use screenshot/vision/HID when semantic APIs are missing.

Limitations compared with a fully native Codex-style runtime:

- The current TS provider depends on existing daemon ops and does not yet expose every AX attribute/action.
- Menu selection is still a JXA prototype and foreground-dependent.
- Element focus via `AXFocused` is not yet a first-class daemon op.
- AX child-index `path` is stable for a snapshot but can stale after UI reflow; validation mitigates but does not eliminate this.
- Screen Recording and Automation prompts cannot be fully solved from library code; packaging/signing is part of reliability.

## Smoke validation

From the package root:

```bash
npm run build
node dist/scripts/macos-computer-use-smoke.js
```

Expected on non-macOS:

- Provider loads.
- Capability report says `supported=false`.
- Smoke returns `mode=unsupported-platform`.
- No attempt is made to start the Swift daemon or call `osascript`.

Expected on macOS after permissions:

- `listApps()` returns running regular apps.
- `listWindows({ pid })` returns windows for the active app.
- `readTree({ pid })` returns AX nodes with `snapshotId`, `flatElements`, and selectors.
- `executeAction({ name: 'press', selector })` reports `daemon.axPress` when native AXPress succeeds, or `daemon.hidClick` when it falls back.
- `executeAction({ name: 'setValue', selector, value })` reports `daemon.axSetValue` when AXValue is settable, or `daemon.hidType` fallback.

For real-machine QA and TCC troubleshooting, use the extended verification package:

```bash
node dist/scripts/macos-computer-use-verify.js --processName Finder
node dist/scripts/macos-computer-use-verify.js --processName TextEdit --run-actions \
  --setvalue-selector-json '{"AXRole":"AXTextArea"}' \
  --text 'SpectrAI macOS AX verification'
```

See `docs/computer-use-macos-tcc-runbook.md` for the permission checklist, TCC reset commands, failure triage matrix, and QA reporting template. See `tests/fixtures/macos-computer-use-verification.json` for scenario-level expected output fields.

JXA prototype examples:

```bash
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op listApps
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op windowState --processName Finder
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op selectMenu --processName Finder --menuPath '["File","New Finder Window"]'
```

## Future Swift helper route

Recommended next daemon ops:

- `axReadTree` that returns full parent/child hierarchy and selected/focused attributes without screenshot coupling.
- `axFindElement` implemented in Swift for lower latency and richer predicates.
- `axFocusElement` using `kAXFocusedAttribute` and `kAXRaiseAction`.
- `axPerformAction` with requested AX action name and capability discovery from `AXUIElementCopyActionNames`.
- `axSetSelectedChildren` / menu selection for native menus.
- `captureWindowState` with ScreenCaptureKit-backed visual verification.

The current provider is therefore a runnable, cross-platform-safe skeleton that can be loaded today, reuses the available Swift daemon, and documents the exact route to a stronger native macOS helper.

## Post-merge Core Provider contract adapter

Round-2 composition smoke requires more than the provider-local API. The local macOS provider still keeps `listApps`, `listWindows`, `readTree`, `findElement`, `executeAction`, and `getCapabilityReport` for compatibility, and the new adapter layer maps that API to the Core-style provider contract:

- `src/computer-use/providers/macos/schema.ts` defines the Core-facing shape: `getCapabilities`, `getAppState`, `getAppTree`, `findElement`, `invokeElement`, `setValue`, `selectMenu`, action verification, fallback report, and capability report.
- `src/computer-use/providers/macos/contract-adapter.ts` implements `MacOSCoreProviderAdapter`, adapting the provider-local API to the Core method names and return structures.
- `src/computer-use/providers/macos/bridge.ts` exposes `createMacOSCoreBridge()` so a runtime/registry can bind the local provider through the adapter.
- `src/computer-use/providers/macos/__tests__/provider-contract.test.ts` uses a fake provider source and a ProviderRegistry-like harness. It does not call AXUIElement, Swift, ScreenCaptureKit, or Apple Events, so it runs on Windows CI.

The adapter contract is intentionally explicit about fallback semantics:

| Core method | Local provider path | Verification | Fallback report |
| --- | --- | --- | --- |
| `getCapabilities()` | `getCapabilityReport()` | `none` | operation-level fallback matrix |
| `getAppState(selector)` | `listApps()` + `listWindows(selector)` | `state-read` | blocked when app/window state cannot be read |
| `getAppTree(selector)` | `readTree(selector)` | `ax-tree` | `vision` fallback declared when AX is sparse |
| `findElement(selector)` | `findElement(selector)` | `ax-tree` | null when not found |
| `invokeElement(selector)` | `executeAction({ name: 'invoke' })` | AX reread / snapshot result | `hid` or `vision` if daemon falls back |
| `setValue(selector, value)` | `executeAction({ name: 'setValue' })` | `state-read` / AX value reread | `hid` when AXValue is not settable |
| `selectMenu({ path })` | `executeAction({ name: 'selectMenu' })` | `state-read` / app-specific follow-up | `jxa`, foreground required |

Windows-local validation commands:

```bash
npm run build
npx tsc --noEmit
node --test dist/computer-use/providers/macos/__tests__/provider-contract.test.js
```

Expected result for the contract test:

- Provider id is `macos-ax`.
- ProviderRegistry-like composition accepts the adapter.
- Capability report includes Accessibility, Screen Recording, Automation and operation fallback metadata.
- App/window/tree mapping returns Core `providerId`, `ElementNode`, `verification`, and `fallback` fields.
- `invokeElement`, `setValue`, and `selectMenu` expose action result + post-action verification + fallback shape.

Suggested persistent logs for canonical report collection:

```bash
mkdir -p artifacts
npm run build > artifacts/macos-provider-build.log 2>&1
npx tsc --noEmit > artifacts/macos-provider-tsc.log 2>&1
node --test dist/computer-use/providers/macos/__tests__/provider-contract.test.js > artifacts/macos-provider-contract.log 2>&1
```

Current Windows blocked boundary:

- macOS true AX smoke is blocked on Windows because `AXUIElement*`, TCC prompts, ScreenCaptureKit/CoreGraphics capture, `osascript`, JXA, and System Events are Darwin-only.
- Windows CI evidence is therefore contract/composition evidence, not a claim that a real macOS target was mutated.
- Real macOS validation still needs a signed/consistent host process, user-granted Accessibility, Screen Recording for visual verification, and Automation grants for menu selection.

Additional macOS helper scripts added for real-machine follow-up:

```bash
src/scripts/macos-tcc-check.sh
src/scripts/macos-ax-prototype.sh list-apps
src/scripts/macos-ax-prototype.sh window-state Finder
src/scripts/macos-ax-prototype.sh ax-tree TextEdit 5
src/scripts/macos-ax-prototype.sh press TextEdit '{"AXTitle":"Save","AXRole":"AXButton"}'
src/scripts/macos-ax-prototype.sh set-value TextEdit '{"AXRole":"AXTextArea"}' 'hello from SpectrAI'
src/scripts/macos-ax-prototype.sh select-menu Finder '["File","New Finder Window"]'
```
