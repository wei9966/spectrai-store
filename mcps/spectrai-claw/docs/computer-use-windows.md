# Windows Computer Use Provider

本文档说明 `mcps/spectrai-claw/src/computer-use/providers/windows` 下的 Windows UIA/Win32 provider 原型。它把现有 SpectrAI Claw Windows UIA、Win32、IAccessible wake-up、HID fallback 能力包装成可被 Universal Computer Use Runtime 接入的 provider 形态。

## 目标

- 优先后台/语义读取：通过 Windows UI Automation 读取 app/window/control tree。
- 优先后台/语义动作：优先使用 `InvokePattern`、`ValuePattern`、`TogglePattern`、`SelectionItemPattern`、`ExpandCollapsePattern`。
- Win32 semantic fallback：对 HWND-backed 控件尝试 `BM_CLICK`、`WM_SETTEXT`。
- 只在显式允许时使用 foreground/HID/vision fallback，不假装后台成功。
- 不破坏旧 MCP 工具：`screenshot_click`、`click_element`、`uia_get_tree`、`uia_find_element`、`keyboard_type`、`keyboard_hotkey`、`window_*` 继续走原链路。

## 文件

- `src/computer-use/providers/windows/types.ts`：Windows provider 本地 canonical types。
- `src/computer-use/providers/windows/uia-mapper.ts`：UIA raw node -> `ElementNode` 映射、selector 匹配、元素 capability 推断。
- `src/computer-use/providers/windows/provider.ts`：`WindowsComputerUseProvider` 主实现。
- `src/computer-use/providers/windows/index.ts`：导出入口。
- `src/computer-use/providers/windows/uia-mapper.test.ts`：无需真实 UIA 环境的 smoke test。

## Provider API

```ts
import { windowsComputerUseProvider } from './computer-use/providers/windows/index.js'

await windowsComputerUseProvider.listApps()
await windowsComputerUseProvider.listWindows()
await windowsComputerUseProvider.getAppState({ includeTree: true, processId: 1234 })
await windowsComputerUseProvider.readTree({ processId: 1234, depth: 4 })
await windowsComputerUseProvider.findElement({ selector: { automationId: 'saveButton' }, processId: 1234 })
await windowsComputerUseProvider.executeAction({ selector: { name: 'Save', controlType: 'Button' }, action: 'invoke', requireBackground: true })
await windowsComputerUseProvider.executeAction({ selector: { automationId: 'titleEdit' }, action: 'setValue', value: 'Hello' })
await windowsComputerUseProvider.getCapabilityReport()
```

兼容 Agent A 后续 core registry 时，以上方法可作为 Windows provider adapter 的薄实现入口。

## Selector 支持

`ElementSelector` 支持以下可序列化字段：

- `id`
- `automationId`
- `name`
- `text`
- `containsText`
- `role`
- `controlType`
- `className`
- `frameworkId`
- `processId`
- `windowId`
- `path`，例如 `[0, 1]` 或 `"0/1"`
- `bounds`，支持 `x/y/width/height` 局部匹配
- `app` 保留给上层 runtime 做 app/window 路由

返回元素统一为 `ElementNode`，包含：`provider/source/role/controlType/name/text/value/automationId/className/frameworkId/processId/nativeWindowHandle/bounds/path/patterns/supportedActions/capabilities/children`。

## Action 支持矩阵

| Action | 后台安全 | 首选语义机制 | Win32 fallback | Foreground/HID fallback | 失败语义 |
|---|---:|---|---|---|---|
| `invoke` | 是，元素支持时 | `InvokePattern`，再试 Toggle/Selection/ExpandCollapse | `BM_CLICK`，仅 HWND-backed | 显式 `allowFallback` 后 HID click | `capability` / `requires_foreground` |
| `click` | 是，元素支持时 | UIA semantic pattern dispatch | `BM_CLICK` | 显式 `allowFallback` 后 HID click | `capability` / `requires_foreground` |
| `clickFallback` | 否 | 无 | 无 | HID `mouse_event` at bounds center | `requires_foreground` |
| `setValue` | 是，元素支持时 | `ValuePattern.SetValue` | `WM_SETTEXT`，仅 HWND-backed edit | 不自动假装后台输入 | `capability` / `requires_foreground` |
| `type` | 是，元素支持时 | 同 `setValue` | `WM_SETTEXT` | 旧 `keyboard_type`/SendKeys 仍保留为旧工具路径 | `capability` / `requires_foreground` |
| `select` | 是，元素支持时 | `SelectionItemPattern.Select` | 暂无 | 显式 fallback 可 HID click | `capability` / `verification_failed` |
| `focus` | 通常是 | `AutomationElement.SetFocus` | 暂无 | 可由旧 `window_focus` 前台化 | `requires_foreground` |
| `toggle` | 是，元素支持时 | `TogglePattern.Toggle` | 暂无 | 显式 fallback 可 HID click | `capability` / `verification_failed` |
| `expandCollapse` | 是，元素支持时 | `ExpandCollapsePattern.Expand/Collapse` | 暂无 | 显式 fallback 可 HID click | `capability` / `verification_failed` |
| `hotkey` | 否 | 无 | 无 | `WScript.Shell.SendKeys` foreground | `requires_foreground` |

## Capability report 示例

```json
{
  "provider": "windows-uia-win32",
  "platform": "windows",
  "backgroundRead": true,
  "backgroundInvoke": true,
  "backgroundType": true,
  "requiresForeground": false,
  "visionFallbackNeeded": false,
  "supportsUia": true,
  "supportsWin32Semantic": true,
  "supportsIAccessibleWake": true,
  "supportsHidFallback": true,
  "actionMatrix": [
    {
      "action": "invoke",
      "background": true,
      "requiresForeground": false,
      "primaryMechanism": "UIA InvokePattern",
      "fallbackMechanisms": ["UIA TogglePattern", "UIA SelectionItemPattern", "UIA ExpandCollapsePattern", "Win32 BM_CLICK", "HID click when explicitly allowed"]
    },
    {
      "action": "hotkey",
      "background": false,
      "requiresForeground": true,
      "primaryMechanism": "foreground WScript.Shell.SendKeys",
      "fallbackMechanisms": []
    }
  ]
}
```

元素级 capability 会根据 `patterns/nativeWindowHandle/controlType/className/source/bounds` 单独推断：例如 OCR-only 元素会返回 `visionFallbackNeeded=true`，无 UIA/Win32 语义动作时返回 `requiresForeground=true`。

## 动作后验证

`executeAction` 默认会在以下动作后重新读取 UIA tree 并验证：

- `setValue` / `type`：重新读取 `Value/Text/Name`，确认包含目标文本。
- `select`：检查 `IsSelected` 或 focus 状态。
- `focus`：检查 `HasKeyboardFocus`。
- `toggle`：检查 `ToggleState` 是否变化。
- `expandCollapse`：检查 `ExpandCollapseState` 是否变化。

`invoke/click` 可能导致窗口关闭或 UI 跳转，provider 只确认 dispatch 成功；场景级断言由上层 runtime/benchmark 在 action 后重新读取状态完成。

## 与旧 Claw MCP 工具兼容

本 provider 不注册或改写现有 MCP tool，因此不会破坏：

- `screenshot` / `zoom_screenshot` / `screenshot_click`
- `click_element`
- `keyboard_type` / `keyboard_press` / `keyboard_hotkey`
- `uia_find_element` / `uia_get_tree`
- `window_list` / `window_focus` / `window_close`
- `mouse_click` / `mouse_move` / `mouse_scroll`

旧工具已经在 `desktop-tools.ts` 中实现 UIA Pattern 优先与 HID fallback；新 provider 复用同一个 `PersistentShell` 预加载环境与 Win32/IAccessible helper，并以 `ElementNode` / `CapabilityReport` 形式向 Universal Computer Use Runtime 暴露能力。

## Windows smoke 验证

真实应用验证包见 `docs/computer-use-windows-real-app-validation.md`，其中包含 Notepad/Calculator/Explorer 场景 fixture、capability 预期、真机 smoke 命令和排障矩阵。

无需真实 UIA 环境的 smoke test：

```bash
npx tsc --noEmit
node --test dist/computer-use/providers/windows/uia-mapper.test.js
```

可选真实 Windows 验证步骤：

1. 打开 Notepad 或 Calculator。
2. 调用 `listWindows()`，确认目标窗口包含 `handle/processId/bounds`。
3. 调用 `readTree({ processId, depth: 4 })`，确认控件包含 UIA `patterns`。
4. 对按钮调用 `executeAction({ selector: { name: '...', controlType: 'Button', processId }, action: 'invoke', requireBackground: true })`。
5. 对输入框调用 `executeAction({ selector: { controlType: 'Edit', processId }, action: 'setValue', value: 'hello', requireBackground: true })`。
6. 若返回 `requires_foreground`、`vision_fallback_needed` 或 `capability`，上层 runtime 应切到 foreground/vision/HID fallback，而不是重复后台动作。

## 已知边界

- UAC/elevated/integrity-isolated app 可能拒绝 UIA 或 Win32 message。
- `WM_SETTEXT` 只适合 HWND-backed edit 控件；现代 Chromium/Electron/自绘控件通常需要 UIA、IAccessible wake 或视觉 fallback。
- `hotkey` 是 foreground-only 能力，provider 会明确返回 `requires_foreground`，不会标记为 background-safe。
- 视觉/OCR/HID fallback 仍由旧工具链提供；本 provider 只在 capability/failure 中明确建议 fallback。
