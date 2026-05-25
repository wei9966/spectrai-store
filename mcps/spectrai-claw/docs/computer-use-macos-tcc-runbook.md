# macOS Computer Use Real-Machine Verification and TCC Runbook

This runbook is for QA/developers validating the macOS Accessibility provider on a real macOS host. It does not depend on the unfinished Universal Computer Use Core; it exercises the provider and scripts added under `src/computer-use/providers/macos` and `src/scripts/macos-*`.

## Safety model

Default verification is read-only:

- `macos-computer-use-verify.ts` lists apps/windows and reads AX tree state.
- It does **not** press buttons or type text unless `--run-actions` is passed.
- Press actions require an explicit `--press-selector-json` unless `--allow-first-actionable` is used.
- Text mutation should be tested only in a scratch TextEdit document.

Non-macOS hosts must return `mode=unsupported-platform` and must not invoke the Swift daemon or `osascript`.

## Build and quick start

From `mcps/spectrai-claw`:

```bash
npm ci
npm run build
node dist/scripts/macos-computer-use-verify.js
```

Expected on Windows/Linux:

```json
{
  "ok": true,
  "mode": "unsupported-platform",
  "platform": "win32",
  "stages": [
    { "name": "capability-report", "status": "skip" }
  ]
}
```

Expected on macOS before permissions are fully granted:

- `capability-report` prints permission status as `granted`, `missing`, or `unknown`.
- Read stages may fail with permission hints; use the checklist below.

## Permission checklist

### 1. Accessibility

Required for AX tree reads and semantic AX actions.

GUI path:

1. Open **System Settings**.
2. Go to **Privacy & Security** -> **Accessibility**.
3. Enable the launching app:
   - Terminal/iTerm/VS Code when running from source.
   - The signed SpectrAI helper/app when packaged.
4. Restart the terminal/app after granting permission.

Validation commands:

```bash
cd mcps/spectrai-claw
node dist/scripts/macos-computer-use-verify.js --processName Finder --max-depth 4 --max-count 80
```

Expected:

- `list-apps` = `pass`
- `list-windows` = `pass`
- `read-ax-tree` = `pass`
- `read-ax-tree.detail.elementCount >= 1`

If missing:

- Errors often mention permission, authorization, AX failure, or empty AX tree.
- Reset and re-grant if the wrong binary identity was authorized.

### 2. Screen Recording

Required for ScreenCaptureKit/CGWindow snapshots, vision/OCR fallback, and screenshot-based post-action verification.

GUI path:

1. **System Settings** -> **Privacy & Security** -> **Screen Recording**.
2. Enable the launching terminal/helper.
3. Restart the launching app.

Validation:

```bash
node dist/scripts/macos-computer-use-verify.js --processName Finder
```

Check `capability.permissionsRequired` for `Screen Recording`. If it is `missing`, AX-only checks may still pass, but visual fallback is not ready.

### 3. Automation

Required for `osascript`/JXA System Events menu selection.

GUI path:

1. Trigger the JXA command once so macOS prompts.
2. Approve prompts for the launching app controlling **System Events** and the target app.
3. Inspect **System Settings** -> **Privacy & Security** -> **Automation**.

Validation command:

```bash
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op selectMenu --processName Finder --menuPath '["File","New Finder Window"]'
```

Expected JSON:

```json
{
  "ok": true,
  "data": { "processName": "Finder", "clicked": ["File", "New Finder Window"] },
  "warnings": ["menu selection requires foreground menu bar + Automation permission."]
}
```

Notes:

- Menu names are localized. Adjust `menuPath` for non-English systems.
- JXA menu selection is a foreground UI-scripting prototype, not a background-safe path.

### 4. Input Monitoring

Not required for current AX read/AXPress/AXSetValue path. Keep it listed for future low-level event observation and HID diagnostics.

If future helpers add keyboard event observation:

1. **System Settings** -> **Privacy & Security** -> **Input Monitoring**.
2. Grant the stable signed helper/app.
3. Restart the helper/app.

## TCC reset commands

Use only on a development machine. These commands reset permissions for the bundle identifier of the terminal/helper. The exact identifier varies by app.

Common examples:

```bash
# Apple Terminal
BUNDLE_ID=com.apple.Terminal

# iTerm2
BUNDLE_ID=com.googlecode.iterm2

# Visual Studio Code
BUNDLE_ID=com.microsoft.VSCode

# Reset Accessibility for one app identity
tccutil reset Accessibility "$BUNDLE_ID"

# Reset Screen Recording for one app identity
tccutil reset ScreenCapture "$BUNDLE_ID"

# Reset Apple Events / Automation for one app identity
tccutil reset AppleEvents "$BUNDLE_ID"

# Broad development reset; use cautiously
tccutil reset Accessibility
tccutil reset ScreenCapture
tccutil reset AppleEvents
```

After reset:

1. Quit and reopen the launching app.
2. Run the relevant validation command to trigger prompts.
3. Grant permissions in System Settings.
4. Quit and reopen again before judging results.

## Signing, sandbox, and path stability

TCC permissions attach to code identity, not just file path.

Checklist:

- Prefer a stable signed helper/app for repeated QA.
- Avoid switching between Terminal, VS Code, and packaged app without granting each identity.
- `swift run` and changing build outputs can look like different executables to TCC.
- A sandboxed helper may need additional entitlements and still may not be suitable for broad UI automation.
- If a previously working permission fails after rebuild, re-grant the current executable identity.

Suggested diagnostic commands:

```bash
codesign -dv --verbose=4 /path/to/helper-or-launching-app 2>&1 | head -80
spctl -a -vv /path/to/helper-or-launching-app
```

Unsigned local scripts can still work during development when the launching terminal has permissions, but packaged QA should validate the signed route.

## QA command sequences

### A. Non-macOS safe path

```bash
cd mcps/spectrai-claw
npm ci
npm run build
node dist/scripts/macos-computer-use-verify.js
```

Expected:

- `ok=true`
- `mode=unsupported-platform`
- no Swift daemon start
- no `osascript`

### B. macOS read-only AX path

```bash
cd mcps/spectrai-claw
npm ci
npm run build
node dist/scripts/macos-computer-use-verify.js --processName Finder --max-depth 5 --max-count 120
```

Expected stages:

- `capability-report`: `pass`
- `list-apps`: `pass`
- `list-windows`: `pass`
- `read-ax-tree`: `pass`
- action stages: `skip`

### C. Find a selector

First inspect the read-only output and copy `firstActionable` or `firstText`. Then run an explicit selector.

```bash
node dist/scripts/macos-computer-use-verify.js --processName Finder --selector-json '{"AXRole":"AXButton"}'
```

Expected:

- `find-ax-selector`: `pass`
- `detail.found=true` when Finder exposes a matching button.

### D. TextEdit setValue/action verification

Use a scratch document only.

```bash
open -a TextEdit
node dist/scripts/macos-computer-use-verify.js --processName TextEdit --run-actions \
  --setvalue-selector-json '{"AXRole":"AXTextArea"}' \
  --text 'SpectrAI macOS AX verification'
```

Expected:

- `focus-window-or-app`: `pass` or `unknown` with window-state detail.
- `set-value-or-type`: `pass`.
- Preferred method: `daemon.axSetValue`.
- Acceptable fallback: `daemon.hidType` with `requiresForeground=true`, if the AX text area is not settable.

### E. Press action with explicit selector

Use only a known safe target. Example after inspecting Finder output:

```bash
node dist/scripts/macos-computer-use-verify.js --processName Finder --run-actions \
  --press-selector-json '{"AXRole":"AXButton","AXTitle":"Back"}'
```

Expected:

- `press-or-invoke`: `pass` if selector resolves.
- Method is `daemon.axPress` when AXPress succeeds.
- Method may be `daemon.hidClick` if AX action is unsupported; this requires foreground correctness.

### F. JXA menu automation

```bash
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op listApps
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op windowState --processName Finder
osascript -l JavaScript src/scripts/macos-ax-smoke.jxa --op selectMenu --processName Finder --menuPath '["File","New Finder Window"]'
```

Expected:

- First command returns running apps.
- Second command returns Finder window state.
- Third command returns `ok=true` after Automation permission is granted.

## Failure triage matrix

| Symptom | Likely cause | Stage | Fix |
| --- | --- | --- | --- |
| `unsupported-platform` on macOS | Running under non-darwin Node or remote shell reports wrong platform | `capability-report` | Verify `node -p process.platform` returns `darwin`. |
| `Failed to connect daemon socket` | Swift daemon/helper not built or not started | `list-apps`, `read-ax-tree`, actions | Run `npm run build:swift` on macOS; check helper path and daemon lifecycle logs. |
| `ePermission`, `not authorized`, `AX failure` | Accessibility not granted to launching identity | `read-ax-tree`, actions | Grant Accessibility, restart launching app, rerun. |
| `read-ax-tree` passes but element count is 0 | Target has sparse AX, invisible/minimized window, or custom UI | `read-ax-tree` | Make window visible/frontmost, try TextEdit/Finder, or enable visual/CDP fallback. |
| Selector not found | Selector too strict, locale mismatch, stale `path`, UI reflow | `find-ax-selector`, actions | Re-run read-only smoke, copy fresh selector/path, prefer identifier/title over bounds. |
| Press returns `daemon.hidClick` | AXPress unsupported or stale AX path | `press-or-invoke` | Accept foreground fallback or choose a standard AXButton/AXMenuItem; refresh snapshot. |
| setValue returns `daemon.hidType` | AXValue not settable, secure/custom editor, stale selector | `set-value-or-type` | Use TextEdit scratch doc, ensure editable text area, accept foreground HID fallback if needed. |
| JXA says not authorized | Automation denied for System Events/target app | JXA commands | Grant Automation, run prompt-triggering command again, reset AppleEvents if needed. |
| JXA cannot find menu item | Locale/menu state mismatch or target not frontmost | JXA `selectMenu` | Localize `menuPath`, make target foreground, verify menu exists manually. |
| Screenshot/vision fallback unavailable | Screen Recording missing | Capability/fallback stages | Grant Screen Recording and restart launching app. |
| Permission worked yesterday but fails after rebuild | TCC code identity/path changed | Any TCC-gated stage | Re-grant current signed helper/terminal identity; avoid changing helper path during QA. |
| Window focus verification unknown | Window list lacks frontmost metadata or app has no normal window | `focus-window-or-app` | Check target app/window manually; unknown is acceptable if subsequent AX state proves action. |

## Reporting template

When filing a QA result, include:

```text
macOS version:
CPU architecture:
Node version:
Launching app and bundle id:
Helper signing identity:
Command:
Full JSON output:
Permissions granted: Accessibility / Screen Recording / Automation / Input Monitoring
Observed method: daemon.axPress / daemon.axSetValue / daemon.hidClick / daemon.hidType / JXA
Failure triage row used:
Screenshots or screen recording when visual fallback is involved:
```

## Round-2 contract and blocked evidence

Windows CI/local static validation does not prove a macOS target was mutated, but it must prove the provider can enter the Core composition layer. Use:

```bash
npm run build
npx tsc --noEmit
node --test dist/computer-use/providers/macos/__tests__/provider-contract.test.js
```

On Windows, true macOS verification remains blocked by platform because AXUIElement, TCC prompts, ScreenCaptureKit/CoreGraphics capture, `osascript`, JXA, and System Events are Darwin-only. Record this as `blocked: non-darwin host` in the canonical report, with the contract test output as composition evidence.

On macOS, start with:

```bash
src/scripts/macos-tcc-check.sh
src/scripts/macos-ax-prototype.sh list-apps
src/scripts/macos-ax-prototype.sh window-state Finder
src/scripts/macos-ax-prototype.sh ax-tree TextEdit 5
src/scripts/macos-ax-prototype.sh select-menu Finder '["File","New Finder Window"]'
```

## Related files

- `docs/computer-use-macos.md` — provider design, AX schema mapping, action semantics.
- `src/scripts/macos-computer-use-smoke.ts` — minimal smoke.
- `src/scripts/macos-computer-use-verify.ts` — full real-machine verification script.
- `src/scripts/macos-ax-smoke.jxa` — JXA/System Events prototype.
- `tests/fixtures/macos-computer-use-verification.json` — QA fixture scenarios and expected output fields.
