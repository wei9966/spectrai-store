# Computer Use Post-merge Core Smoke Harness

本文档用于 Windows/macOS/Browser/Fallback Provider 合入后，快速验证它们是否能接入统一 `ComputerUseRuntime`。本 harness 只验证 core integration，不修改、不调用旧 MCP 工具注册入口，也不依赖尚未 accepted 的 provider 主体实现。

## 相关文件

- `src/computer-use/core/stub-provider.ts`
  - `createStubComputerUseProvider()`：可确定输出的 stub provider，用于模拟 Browser、Windows UIA、macOS AX、App bridge、Vision/OCR、HID。
- `src/computer-use/core/post-merge-smoke.ts`
  - `createPostMergeSmokeRegistry(slots)`：组装 provider registry；未传入的 slot 自动使用 stub。
  - `runPostMergeCoreSmokeHarness(options)`：读取 `capabilityReport`、执行 selector action、触发动作后验证，并可生成 fallback recommendation 场景。
- `src/computer-use/__tests__/post-merge-smoke.test.ts`
  - Core-only smoke test；验证 provider 路由优先级、canonical report 字段、fallback recommendation。

## 默认 stub composition

默认 registry 顺序模拟最终真实 provider：

1. `stub-browser-cdp`：`kind = browser`，模拟 DOM/CDP/Playwright。
2. `stub-windows-uia`：`kind = os-accessibility`，模拟 Windows UIA/Win32/IAccessible。
3. `stub-macos-ax`：`kind = os-accessibility`，模拟 macOS AX/AppleScript/JXA。
4. `stub-app-bridge`：`kind = app-bridge`，模拟 app-specific bridge。
5. `stub-vision-ocr`：`kind = vision-ocr`，模拟 screenshot/Vision/OCR fallback。
6. `stub-hid`：`kind = hid`，模拟 mouse/keyboard HID fallback。

该顺序应满足 core 约定：

```text
Browser DOM/CDP > OS Accessibility(UIA/AX) > App-specific bridge > Vision/OCR > HID fallback
```

## 接入真实 provider 的方式

Provider agent 合入后，不需要修改 core runtime；只需把真实 provider 实例传入 slot。未 ready 的 provider 保持 stub 即可。

```ts
import { createPostMergeSmokeRegistry, runPostMergeCoreSmokeHarness } from '../src/computer-use/core/index.js'

// 示例：真实 provider 合入后再打开 import；未合入前保持 stub。
// import { createBrowserProvider } from '../src/computer-use/providers/browser/index.js'
// import { createWindowsProvider } from '../src/computer-use/providers/windows/index.js'
// import { createMacOSProvider } from '../src/computer-use/providers/macos/index.js'

const registry = createPostMergeSmokeRegistry({
  // browser: createBrowserProvider({ debugPort: 9222 }),
  // windowsAccessibility: createWindowsProvider(),
  // macosAccessibility: createMacOSProvider(),
  // visionFallback: createLegacyFallbackProvider(...),
  // hidFallback: createLegacyFallbackProvider(...),
})

const result = await runPostMergeCoreSmokeHarness({
  providers: {
    // 同样可按 slot 替换真实 provider
  },
})

console.log(result.capabilityReport)
console.log(result.actionReport)
console.log(result.fallbackReport)
```

## Smoke harness 覆盖内容

### 1. capability report

`runtime.capabilityReport()` 必须返回 canonical report，并且每个 provider capability 至少包含：

- `backgroundRead`
- `backgroundInvoke`
- `backgroundType`
- `requiresForeground`
- `visionFallbackNeeded`
- `supportedActions`
- `verificationSupport`

### 2. selector action

默认 action：

```json
{
  "type": "click",
  "target": {
    "app": { "appId": "smoke-app" },
    "role": "button",
    "label": "Submit"
  }
}
```

Runtime 路径：

1. `ProviderRegistry.route(action)`
2. `provider.findElement(selector)`
3. `provider.invokeElement(element, action)`
4. `verifyAction(..., mode = visible-state)`
5. 返回 `CanonicalReport`

### 3. post-action verification

默认成功场景要求：

- `report.phase = "execute"`
- `report.result.ok = true`
- `report.result.verification.ok = true`
- `report.verification.mode = "visible-state"`
- `report.fallbackSuggested = false`

### 4. fallback recommendation

Harness 内置一个 browser stub 验证失败场景：执行成功但动作后元素不可见。期望返回：

- `report.ok = false`
- `report.phase = "verify"`
- `report.error.code = "verification_failed"`
- `report.fallbackSuggested = true`
- `report.fallbackProviders = ["stub-vision-ocr", "stub-hid"]`

真实 provider 合入后，如果 Browser/Accessibility provider 的语义动作验证失败，也应保留同样的 canonical fallback recommendation 字段。

## 验证命令

在 `mcps/spectrai-claw` 下运行：

```bash
npx tsc --noEmit
npm run build
node --test dist/computer-use/core/__tests__/runtime.test.js dist/computer-use/__tests__/post-merge-smoke.test.js
```

说明：源码使用 ESM `.js` import，直接跑 `src/**/*.ts` 在当前 Node 配置下会找不到尚未生成的 `.js` 文件；因此 smoke test 以 build 后的 `dist` 产物执行。

## 兼容性边界

- 不修改 `src/tools/desktop-tools.ts`、`desktop-tools-darwin.ts`、Swift daemon、PowerShell UIA/OCR/HID 脚本。
- 不要求 Windows/macOS/Browser provider 已合入；stub slot 保证 core harness 可独立运行。
- 真实 provider 接入时只需实现 `ComputerUseProvider` interface，并通过 registry 注册。
- 旧 MCP 工具继续作为外部能力；可通过 `createLegacyFallbackProvider` 包装为 `vision-ocr` 或 `hid` fallback provider。
