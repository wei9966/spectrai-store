# Browser DOM/CDP smoke evidence - 2026-05-25

Task: Agent D Browser smoke skipped 状态补证据并重新提交评审

Commit baseline: `2229460 Add browser DOM CDP provider smoke`

Evidence file path: `mcps/spectrai-claw/docs/computer-use-browser-smoke-evidence-2026-05-25.md`

## Provider evidence map

- Capability report: `src/computer-use/providers/browser/__tests__/browser-provider.test.ts` test `returns a capability report when live CDP is unavailable` asserts provider, transport, DOM state/tree selector/action capabilities, `requiresScreenshot=false`, `isAvailable=false`, and `backgroundActionSuccessExpected=false` for blocked CDP.
- DOM state: fake-session provider test calls `getAppState()` and asserts form field selector `#search-box`.
- DOM tree / selector locate: fake-session provider test calls `getAppTree()` and checks `#submit-button`, then calls `findElement({ testId: 'search-box' })`.
- Action: fake-session provider test calls `invokeElement(..., 'focus')`, `setValue`, `typeText`, `invokeElement(..., 'click')`, `readText`, and `uploadFiles`.
- Verification: fake-session provider test asserts `verification.strategy === 'dom-post-action'` and `verification.backgroundActionSuccess === true` after click; live smoke source emits `capability-report`, `findElement`, `setValue`, `invokeElement.click`, `typeText`, and verification JSON when CDP is available.

## Commands executed

Working directory: `mcps/spectrai-claw`

### 1. Type check

Command:

```powershell
npx tsc --noEmit
```

Result: passed, exit code `0`.

### 2. Build

Command:

```powershell
npm run build
```

Result: passed, exit code `0`.

Output excerpt:

```text
> spectrai-claw@0.4.0 build
> npx tsc && node -e "const fs=require('fs');const p=require('path');const d=p.join('dist','scripts');fs.mkdirSync(d,{recursive:true});fs.readdirSync(p.join('src','scripts')).filter(f=>f.endsWith('.ps1')).forEach(f=>fs.copyFileSync(p.join('src','scripts',f),p.join(d,f)))"
```

### 3. Browser provider substitute test

Command:

```powershell
node --test dist/computer-use/providers/browser/__tests__/browser-provider.test.js
```

Result: passed, exit code `0`.

Output excerpt:

```text
▶ BrowserComputerUseProvider fallback contract smoke
  ✔ returns a capability report when live CDP is unavailable (18.6538ms)
  ✔ runs DOM state/tree, selector, action and verification through the provider contract without live Chrome (2.6206ms)
✔ BrowserComputerUseProvider fallback contract smoke (22.1369ms)
ℹ tests 2
ℹ suites 1
ℹ pass 2
ℹ fail 0
```

### 4. Live CDP probe

Command:

```powershell
try { $version = Invoke-RestMethod -Uri http://127.0.0.1:9222/json/version -TimeoutSec 2; Write-Host 'CDP_PROBE_OK'; $version | ConvertTo-Json -Depth 4 } catch { Write-Host 'CDP_PROBE_FAILED'; Write-Host $_.Exception.Message; exit 2 }
```

Result: blocked, exit code `2`.

Output:

```text
CDP_PROBE_FAILED
The operation has timed out.
```

Interpretation: Chrome/Chromium was not already listening on `127.0.0.1:9222` in this environment.

### 5. Browser live CDP smoke

Command:

```powershell
node dist/computer-use/providers/browser/browser-cdp-smoke.js; Write-Host "SMOKE_EXIT=$LASTEXITCODE"; exit 0
```

Result: blocked as expected; smoke process exit code was `2` and wrapper exited `0` only to preserve the evidence output.

Output excerpt:

```json
{
  "step": "probe",
  "endpoint": "http://127.0.0.1:9222"
}
```

```text
SMOKE_EXIT=2
```

```json
{
  "ok": false,
  "step": "probe",
  "endpoint": "http://127.0.0.1:9222",
  "error": "fetch failed",
  "reproduce": {
    "windows": "start \"\" \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"%TEMP%\\spectrai-cdp-profile\" about:blank",
    "powershellProbe": "Invoke-RestMethod http://127.0.0.1:9222/json/version",
    "smoke": "npm run build && node dist/computer-use/providers/browser/browser-cdp-smoke.js"
  }
}
```

## Reproduce live CDP smoke

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\spectrai-cdp-profile" about:blank
cd mcps/spectrai-claw
npm run build
node dist/computer-use/providers/browser/browser-cdp-smoke.js
```

When CDP is available, the smoke prints a `capability-report` block followed by DOM state/tree, selector locate, setValue, click, typeText, readText, uploadFiles, and DOM post-action verification blocks.

## Status

- Composition with a real Chrome target: blocked by unavailable local CDP endpoint `127.0.0.1:9222`.
- Minimum substitute contract evidence: passed via fake-session Browser provider test.
- Reviewer can verify command output from this evidence file and rerun the same commands locally.
