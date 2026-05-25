# SpectrAI Claw Universal Computer Use Core Runtime

本文档描述新增的 `src/computer-use` 核心层。它的目标是把 SpectrAI Claw 从“截图编号点击工具”升级为 Universal Computer Use Runtime：

> 目标 App → 状态/控件树/DOM/AX/UIA → selector → 语义动作 → capability report → 动作后验证 → 必要时 Vision/OCR/HID fallback

本次实现是旁路新增，不替换、不删除现有 MCP 工具；现有 `describe_screen` / `click` / `type_text` / screenshot / OCR / HID / Swift daemon 能力可通过 fallback adapter 或 provider 适配接入。

## 文件布局

- `src/computer-use/types.ts`
  - 统一 schema 与类型：`AppState`、`WindowState`、`ElementNode`、`ElementSelector`、`ComputerUseAction`、`ActionResult`、`CapabilityReport`、`CanonicalReport`。
- `src/computer-use/registry.ts`
  - `ProviderRegistry`、默认 provider 优先级、capability-based route。
- `src/computer-use/core/provider.ts`
  - `ComputerUseProvider` 接口。
- `src/computer-use/core/runtime.ts`
  - `ComputerUseRuntime`：`route`、`executeAction`、`readState`、`capabilityReport`。
- `src/computer-use/core/verification.ts`
  - 动作后验证 hook：`read`、`compare`、`visible-state`、`dom-tree`。
- `src/computer-use/core/fallback.ts`
  - `createLegacyFallbackProvider`，用于把现有 screenshot/OCR/HID 回调包装成 provider。
- `src/computer-use/core/report.ts`
  - canonical success/failure report helpers。
- `src/computer-use/core/__tests__/runtime.test.ts`
  - 最小 smoke test：路由排序、语义执行、验证失败 fallback 提示。

## 统一状态与元素 schema

核心对象围绕四层结构：

```ts
AppState {
  appId,
  providerId,
  providerKind,
  platform,
  pid?,
  bundleId?,
  windows: WindowState[],
  root?: ElementNode,
  snapshotId?,
  capturedAt,
}
```

```ts
ElementNode {
  id,
  providerId?,
  source: 'dom' | 'cdp' | 'uia' | 'ax' | 'vision' | 'ocr' | 'hid' | ...,
  role?, label?, name?, value?,
  bounds?,
  isEnabled?, isVisible?, isEditable?, isActionable?,
  supportedActions?,
  children?,
  selectorHints?,
  nativeRef?,
}
```

`ElementSelector` 既支持跨平台语义字段，也保留原生定位线索：

```json
{
  "app": { "appId": "chrome", "url": "https://example.com" },
  "role": "button",
  "label": "Submit",
  "css": "button[type=submit]",
  "automationId": "submit-btn",
  "axPath": [0, 2, 4],
  "bounds": { "x": 100, "y": 200, "width": 80, "height": 32 }
}
```

## Provider interface

每个 provider 必须实现同一接口：

```ts
interface ComputerUseProvider {
  id: string
  kind: 'browser' | 'os-accessibility' | 'app-bridge' | 'vision-ocr' | 'hid' | 'mock'
  platform: 'windows' | 'macos' | 'linux' | 'browser' | 'cross-platform' | 'unknown'

  listApps(context?): Promise<AppState[]>
  getAppState(target, options?): Promise<AppState>
  getAppTree(target, options?): Promise<ElementNode>
  findElement(selector, options?): Promise<ElementNode | null>
  invokeElement(element, action?, options?): Promise<ActionResult>
  setValue(element, value, options?): Promise<ActionResult>
  selectMenu(target, menuPath, options?): Promise<ActionResult>
  getCapabilities(target?, context?): Promise<CapabilityReport>
}
```

Windows provider 可把 UIA/Win32/IAccessible pattern 映射到 `os-accessibility`；macOS provider 可把 AXUIElement/JXA/AppleScript 映射到 `os-accessibility`；Browser provider 可把 DOM/CDP/Playwright 映射到 `browser`；现有 Vision/OCR/HID 能力可包装为 `vision-ocr` 或 `hid` fallback provider。

## Capability report

`CapabilityReport` 明确表达 provider 能力边界：

```json
{
  "providerId": "browser-cdp",
  "providerKind": "browser",
  "platform": "browser",
  "source": ["dom", "cdp"],
  "priority": 0,
  "backgroundRead": true,
  "backgroundInvoke": true,
  "backgroundType": true,
  "requiresForeground": false,
  "visionFallbackNeeded": false,
  "supportedActions": ["readState", "invoke", "click", "setValue", "typeText"],
  "verificationSupport": ["read", "compare", "visible-state", "dom-tree"],
  "supportsElementTree": true,
  "supportsSelectorLookup": true,
  "supportsWindowState": true,
  "permissions": ["remote-debugging-port"],
  "limitations": []
}
```

关键字段：

- `backgroundRead`：能否后台读取 App/window/tree/DOM/AX/UIA 状态。
- `backgroundInvoke`：能否后台执行 invoke/click/select 等语义动作。
- `backgroundType`：能否后台设置值或输入文本。
- `requiresForeground`：是否必须前台聚焦。
- `visionFallbackNeeded`：是否需要视觉/OCR 才能稳定定位。
- `supportedActions`：provider 可处理的动作集合。
- `verificationSupport`：provider 支持的动作后验证模式。

## 路由策略

默认优先级位于 `src/computer-use/registry.ts`：

1. Browser DOM/CDP：`browser`
2. OS Accessibility：`os-accessibility`，包括 Windows UIA/Win32/IAccessible 和 macOS AX
3. App-specific bridge：`app-bridge`
4. Vision/OCR：`vision-ocr`
5. HID fallback：`hid`

`ProviderRegistry.route(action)` 会：

1. 解析并标准化 `ComputerUseActionInput`。
2. 读取 provider capability。
3. 过滤不支持该 action 的 provider。
4. 按默认优先级、provider `priority`、用户指定 preferred provider 排序。
5. 默认包含 fallback provider；可通过 `allowFallback: false` 禁用。

## 动作执行与验证

`ComputerUseRuntime.executeAction(action)` 的关键路径：

1. route provider。
2. 如果 action 带 selector，先调用 `provider.findElement(selector)` 定位元素。
3. 按 action 类型分发：
   - `invoke` / `click` / `focus` / `select` → `invokeElement`
   - `setValue` → `setValue`
   - `typeText` → 有 target 时 `setValue`，无 target 时交给 provider 的 `invokeElement` 处理 focused typing / HID typing
   - `selectMenu` → `selectMenu`
   - `readState` → `getAppState`
4. 动作后执行 verification hook：
   - `visible-state`：重新 find element 并检查存在/可见/启用状态。
   - `compare`：检查 value/text/state 是否符合预期。
   - `read`：重新读取 AppState。
   - `dom-tree`：重新读取 tree/DOM/AX/UIA 树。
5. 验证失败时返回 canonical failure：`phase: "verify"`，并设置 `fallbackSuggested` 与可用 fallback provider 列表。

## Canonical report

所有 route/read/execute/capability 结果都返回 `CanonicalReport`：

```json
{
  "ok": false,
  "status": "failure",
  "phase": "verify",
  "providerId": "browser-cdp",
  "providerKind": "browser",
  "fallbackSuggested": true,
  "fallbackProviders": ["vision-ocr", "hid"],
  "error": {
    "code": "verification_failed",
    "message": "Element is not visible."
  },
  "route": [
    { "providerId": "browser-cdp", "providerKind": "browser", "priority": 500, "reason": "primary:browser:background-capable" }
  ]
}
```

## 现有 Claw 兼容策略

本次 core runtime 不修改现有 MCP tool 注册入口，也不修改 `src/tools/desktop-tools.ts` / `desktop-tools-darwin.ts` 的公开接口。因此：

- 旧 `describe_screen`、`click`、`type_text`、`hotkey` 等 MCP 工具继续可用。
- macOS Swift daemon 中已有的 `detectElements`、`click`、`type`、`VisionFallbackService` 可由后续 provider 适配为 `os-accessibility` 或 `vision-ocr`。
- Windows PowerShell UIAutomation / OCR / HID 逻辑可由后续 provider 或 `createLegacyFallbackProvider` 包装。
- Browser CDP/DOM provider 可作为 `browser` provider 接入，不需要改变旧截图链路。

示例 fallback 包装：

```ts
const visionProvider = createLegacyFallbackProvider({
  id: 'legacy-vision-ocr',
  kind: 'vision-ocr',
  platform: 'cross-platform',
  source: ['vision', 'ocr', 'snapshot'],
  findElement: async (selector) => legacyDetectByScreenshot(selector),
  invokeElement: async (element, action) => legacyClickByBounds(element, action),
})
```

## 对标 Codex Computer Use 的含义

Codex Computer Use 的核心不只是“看图点击”，而是先尽可能读取结构化 App 状态，再使用可验证的语义动作：

- Browser：优先 DOM/CDP selector，支持后台读写与 DOM-tree 验证。
- Windows：优先 UIA/Win32/IAccessible tree 与 pattern，如 Invoke/Value/Selection。
- macOS：优先 AXUIElement tree 与 AXPress/AXValue/AXMenuItem。
- App bridge：针对特定应用的 API/IPC bridge 可作为高置信 provider。
- Vision/OCR/HID：只作为无法结构化读取或语义动作失败时的兜底。

新增 core runtime 将这些能力统一到 provider contract、capability report、selector/action schema、verification hook 和 canonical report 中。

## 验证命令

在 `mcps/spectrai-claw` 下运行：

```bash
npm ci
npx tsc --noEmit
npm run build
node --test dist/computer-use/core/__tests__/runtime.test.js
```

当前验证结果：

- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `node --test dist/computer-use/core/__tests__/runtime.test.js`：3 个测试通过。
- 直接运行 `node --test src/computer-use/core/__tests__/runtime.test.ts` 会因为项目 TS/ESM 源码使用 `.js` import、源码目录没有生成 JS 而出现 `ERR_MODULE_NOT_FOUND`；因此 smoke test 以 build 后的 `dist` 产物执行。
