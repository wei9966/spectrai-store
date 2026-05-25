# Computer Use Provider Onboarding Checklist

This document is the stable integration checklist for Windows UIA/Win32, macOS AX, Browser DOM/CDP, Vision/OCR, HID, and benchmark providers. It complements `computer-use-architecture.md` and does not require modifying legacy Claw MCP tools.

## Scope

Provider owners should only implement adapters that satisfy `src/computer-use/types.ts` and register with `ComputerUseProviderRegistry`. Do not change the core schema unless a provider cannot represent a real platform capability with the existing fields.

## Minimum provider contract

Every provider must implement `ComputerUseProvider`:

- identity: `id`, `name`, `kind`, `platform`
- discovery/read: `listApps`, `getAppState`, `getAppTree`
- selector resolution: `findElement`
- actions: `invokeElement`, `setValue`, `selectMenu`
- capability introspection: `getCapabilities`

### Provider ID and kind

| Provider | Suggested id | kind | platform | Notes |
| --- | --- | --- | --- | --- |
| Windows UIA/Win32 | `windows-uia` | `os-accessibility` | `windows` | UIA tree/read/invoke/value/selection first; Win32/HID stays fallback. |
| macOS AX | `macos-ax` | `os-accessibility` | `macos` | AXUIElement tree/read/press/set value/menu where permission allows. |
| Browser CDP/DOM | `browser-cdp` | `browser-dom-cdp` | `browser` | DOM/ARIA selectors and Playwright/CDP actions; highest route priority. |
| App bridge | `app-bridge:<app>` | `app-bridge` | provider-specific | AppleScript/custom RPC/app automation API. |
| Vision/OCR | `vision-ocr` | `vision-ocr` | `unknown` or OS | Locator fallback only, confidence-scored. |
| HID | `hid-fallback` | `hid-fallback` | OS | Last resort pointer/keyboard events. |

`id` must be stable across process restarts because route telemetry and benchmark reports reference it.

### Registry and priority

Register providers with either:

```ts
registerComputerUseProvider(provider)
```

or, for tests/benchmarks:

```ts
const registry = new ComputerUseProviderRegistry()
registry.register({ provider, priorityOffset: 0, tags: ['windows', 'uia'] })
```

Default route priority is:

1. `browser-dom-cdp`
2. `os-accessibility`
3. `app-bridge`
4. `vision-ocr`
5. `hid-fallback`

Use `priorityOffset` only for local experiments or benchmark variants. Do not use it to make Vision/OCR or HID outrank semantic providers.

## Capability report checklist

`getCapabilities()` must be conservative. If a provider can only do an action after foregrounding the app, set `requiresForeground: true` and keep the relevant `background*` flag false.

Required flags:

| Flag | Meaning | Conservative default |
| --- | --- | --- |
| `backgroundRead` | Can read app/window/tree state without foregrounding. | `false` |
| `backgroundInvoke` | Can invoke semantically without moving pointer/foregrounding. | `false` |
| `backgroundType` | Can set/type value without foreground focus. | `false` |
| `requiresForeground` | Provider generally needs foreground for actions. | `true` |
| `visionFallbackNeeded` | Provider depends on screenshot/OCR to locate targets. | `false` for semantic providers, `true` for Vision/OCR. |
| `supportsElementTree` | Can return a meaningful `ElementNode` tree. | `false` |
| `supportsFindElement` | Can resolve `ElementSelector`. | `false` |
| `supportsInvoke` | Can invoke/click/press an element semantically. | `false` |
| `supportsSetValue` | Can set text/value semantically. | `false` |
| `supportsSelection` | Can select/toggle/choose options semantically. | `false` |
| `supportsMenus` | Can select app/window menu items. | `false` |
| `supportsCoordinates` | Can act by point/bounds. | `false` |
| `supportsScreenshots` | Can capture pixels. | `false` |
| `supportsKeyboard` | Can send keyboard/type events. | `false` |

Capability fields must align with `actionSupport` and `selectorSupport`. `createCapabilityReport()` can infer defaults from flags and provider kind, but provider owners should override when a platform has known gaps.

## Selector support matrix

| Selector strategy | Browser CDP/DOM | Windows UIA | macOS AX | App bridge | Vision/OCR | HID |
| --- | --- | --- | --- | --- | --- | --- |
| `semantic` | ARIA role/name/text | ControlType/Name | AXRole/AXTitle | Bridge model | weak, confidence only | no |
| `role-name` | ARIA role/name | UIA ControlType/Name | AXRole/title | if exposed | weak | no |
| `automation-id` | test id if mapped | UIA AutomationId | rarely | bridge id | no | no |
| `accessibility-id` | ARIA/accessibility id | if available | AXIdentifier | bridge id | no | no |
| `dom-css` | yes | no | no | no | no | no |
| `dom-xpath` | yes | no | no | no | no | no |
| `text` | DOM text | Name/Value/TextPattern | AXValue/title | if exposed | OCR text | no |
| `bounds` | viewport bounds fallback | element rect fallback | element rect fallback | optional | OCR/vision boxes | yes |
| `legacy-element-id` | only if adapter maps snapshot | only if adapter maps snapshot | only if adapter maps snapshot | optional | optional | optional |
| `provider-native` | CDP handle | UIA runtime/native id | AXUIElement ref/id | bridge locator | detector id | focused element/point |

Provider `findElement()` should prefer stable selectors in this order:

1. `providerElementId` or `elementId`
2. automation/accessibility ID
3. semantic role + label/name/text
4. provider-native locator
5. bounds/point fallback

Do not synthesize high-confidence semantic matches from pixels alone. Vision/OCR matches should include `confidence` and `source: 'vision'` or `source: 'ocr'`.

## Action result and telemetry contract

Every action method returns `ActionResult`.

### Successful action

```ts
return {
  ok: true,
  providerId: provider.id,
  method: 'providerInvoke',
  element,
  telemetry: {
    backgroundInvoke: true,
    requiresForeground: false,
    visionFallbackNeeded: false,
    usedHidFallback: false,
  },
}
```

### Unsupported action

Use `eOpUnsupported` for a provider that is healthy but cannot perform this action or selector. This lets the router try lower-priority providers.

```ts
return {
  ok: false,
  providerId: provider.id,
  method: 'providerInvoke',
  error: {
    code: 'eOpUnsupported',
    message: 'UIA InvokePattern is unavailable for this element',
    recoverable: true,
  },
}
```

### Not found / target mismatch

Use `eNotFound` when the selector did not match. Use `eTargetMismatch` when the provider is not applicable to the requested app/window but is otherwise healthy.

```ts
return {
  ok: false,
  providerId: provider.id,
  method: 'semanticProviderAction',
  error: { code: 'eNotFound', message: 'No element matched selector', recoverable: true },
}
```

### Permission or foreground requirement

Use `ePermission` when OS permission blocks read/action. Use `eRequiresForeground` when the provider can act only after app activation. Keep `recoverable` true if another provider or fallback may still work.

### Throwing vs returning failure

Return `{ ok: false, error }` for expected platform limitations. Throw only for provider bugs, malformed internal state, or unexpected exceptions. The router records thrown errors as failed route attempts, but expected limitations should be explicit and benchmarkable.

## Skip semantics

There are two ways for a provider to skip work:

1. **Capability skip**: report `actionSupport[action] = false` or leave the relevant support flag false. Registry will not include the provider in candidates for that action.
2. **Runtime unsupported**: return `ok: false` with `eOpUnsupported`, `eNotFound`, `eTargetMismatch`, `ePermission`, or `eRequiresForeground`. Router records a route attempt and falls through.

Vision/OCR and HID have additional runtime gates:

- `allowVisionFallback: false` produces a `fallback_not_allowed` route attempt for `vision-ocr` providers.
- `allowHidFallback: false` produces a `fallback_not_allowed` route attempt for `hid-fallback` providers.

Provider implementations should not bypass these gates.

## Minimal provider stub

```ts
import {
  createCapabilityReport,
  registerComputerUseProvider,
  type ComputerUseProvider,
} from './computer-use/index.js'

export const provider: ComputerUseProvider = {
  id: 'windows-uia',
  name: 'Windows UIA Provider',
  kind: 'os-accessibility',
  platform: 'windows',
  async listApps() { return [] },
  async getAppState(target) { throw new Error(`not implemented: ${target.name ?? target.processId}`) },
  async getAppTree(target, window) { throw new Error(`not implemented: ${target.name ?? window?.title ?? 'target'}`) },
  async findElement(selector) { return null },
  async invokeElement(selector, action) {
    return { ok: false, providerId: 'windows-uia', method: 'providerInvoke', error: { code: 'eOpUnsupported', message: `unsupported selector: ${selector.strategy}`, recoverable: true } }
  },
  async setValue(selector, value, action) {
    return { ok: false, providerId: 'windows-uia', method: 'providerSetValue', error: { code: 'eOpUnsupported', message: `setValue unsupported for ${selector.strategy}`, recoverable: true } }
  },
  async selectMenu(menu, action) {
    return { ok: false, providerId: 'windows-uia', method: 'providerSelection', error: { code: 'eOpUnsupported', message: 'menu selection unsupported', recoverable: true } }
  },
  async getCapabilities() {
    return createCapabilityReport({
      providerId: 'windows-uia',
      providerName: 'Windows UIA Provider',
      providerKind: 'os-accessibility',
      platform: 'windows',
      flags: {
        backgroundRead: true,
        backgroundInvoke: true,
        backgroundType: true,
        requiresForeground: false,
        supportsElementTree: true,
        supportsFindElement: true,
        supportsInvoke: true,
        supportsSetValue: true,
        supportsSelection: true,
        supportsMenus: true,
      },
      selectorSupport: {
        semantic: true,
        'role-name': true,
        'automation-id': true,
        text: true,
        bounds: true,
        'provider-native': true,
      },
    })
  },
}

registerComputerUseProvider(provider)
```

The stub is intentionally conservative. Provider owners should replace the unsupported returns with real platform calls but keep the error and telemetry conventions.

## Provider-specific integration notes

### Windows UIA / Win32 provider

- Map UIA AutomationElement to `ElementNode` with `source: 'uia'`.
- Prefer UIA patterns: Invoke, Value, Selection, Toggle, ExpandCollapse, Text.
- Use Win32 focus/click/type only as lower-level provider or fallback path.
- Report `backgroundRead` true only for windows that UIA can inspect without activation.
- If an element is visible but pattern is missing, return `eOpUnsupported` rather than falling directly to HID inside the provider unless that provider is explicitly the HID fallback provider.

### macOS AX provider

- Map AXUIElement to `ElementNode` with `source: 'ax'`.
- AX permission failures must return `ePermission` with a clear message.
- Use AXPress/AXSetValue/AXMenuItem where possible; AppleScript or ScreenCaptureKit belongs in `app-bridge` or `vision-ocr` style capabilities unless it exposes semantic nodes.
- If AX requires target activation for a specific app, set `requiresForeground` or return `eRequiresForeground`.

### Browser DOM/CDP provider

- Map DOM/ARIA nodes to `ElementNode` with `source: 'dom'` or `source: 'cdp'`.
- Prefer ARIA role/name and stable CSS/test IDs before XPath or bounds.
- CDP/Playwright actions should report `backgroundInvoke/backgroundType` true only when the tab can be controlled without foregrounding the OS window.
- Use `eTargetMismatch` when the app/window target is not a browser target managed by this provider.

### Vision/OCR provider

- Return `source: 'vision'` or `source: 'ocr'`, include `confidence`, and set `visionFallbackNeeded: true`.
- Do not claim `backgroundInvoke` or `backgroundType` unless paired with a semantic backend.
- For low confidence, return `eNotFound` or an element with confidence below caller threshold; do not silently click.

### HID fallback provider

- Use only for coordinate click, keyboard, scroll, or hotkey fallback.
- Set `requiresForeground: true`, `supportsCoordinates: true`, `supportsKeyboard: true`, and semantic tree flags false.
- Respect `allowHidFallback: false` by relying on router gating; do not register hidden shortcuts around the runtime.

### Benchmark provider

- Read `CapabilityReport` and `ActionResult.route` to compute fallback rate, foreground requirement rate, and semantic success rate.
- Track `providerId`, `method`, `error.code`, `route[].reason`, `telemetry.usedHidFallback`, and `telemetry.visionFallbackNeeded`.

## Pre-merge checklist for provider owners

- [ ] Provider implements all `ComputerUseProvider` methods.
- [ ] `getCapabilities()` is conservative and includes selector/action support.
- [ ] `id`, `kind`, and `platform` match this document.
- [ ] `findElement()` returns stable selectors and source-specific nodes.
- [ ] Unsupported actions return `eOpUnsupported`, not hidden HID fallback.
- [ ] Permission and foreground issues return explicit error codes.
- [ ] `ActionResult.telemetry` is populated for background/foreground/fallback behavior.
- [ ] Vision/OCR and HID behavior can be disabled by runtime options.
- [ ] Legacy `describe_screen` / `click` / `type_text` workflows are not broken.
- [ ] Provider tests use a dedicated `ComputerUseProviderRegistry` instead of mutating the default registry when possible.
