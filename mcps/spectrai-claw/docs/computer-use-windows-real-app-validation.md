# Windows Computer Use Real-App Validation Pack

本验证包用于支撑 Windows UIA/Win32 provider 的最终验收，重点证明：

- 不误点：优先 selector + UIA/Win32 语义动作，不直接依赖截图坐标。
- 可后台：能后台读取 UIA tree，并在可支持控件上后台 invoke/type/select。
- 动作后可验证：语义动作后重新读取 UIA value/focus/selection/state，失败时返回 canonical failure。
- fallback 可解释：视觉/OCR/HID/foreground fallback 必须明确标记，不假装后台成功。

相关文件：

- `tests/fixtures/windows-computer-use-real-apps.json`：真实应用场景 fixture、capability 预期和排障映射。
- `tests/windows-computer-use-fixture.test.mjs`：fixture schema/覆盖校验。
- `scripts/windows-computer-use-smoke.mjs`：fixture-only、read-only 和显式 mutating 真机 smoke。
- `docs/computer-use-windows.md`：Windows provider API 与动作矩阵。

## 运行方式

先构建 provider：

```bash
npm run build
```

只验证 fixture，不访问真实桌面：

```bash
node --test tests/windows-computer-use-fixture.test.mjs
node scripts/windows-computer-use-smoke.mjs --fixture-only
```

只验证 provider read-only 能力，不改变应用状态：

```bash
node scripts/windows-computer-use-smoke.mjs --list-only
node scripts/windows-computer-use-smoke.mjs --read-only
```

显式运行真实语义动作验证，可能会打开或修改 Calculator/Notepad/Explorer：

```bash
SPECTRAI_WINDOWS_MUTATING_SMOKE=1 node scripts/windows-computer-use-smoke.mjs --mutate --launch
```

> 注意：`--mutate` 只应在解锁的交互式 Windows 桌面执行。Notepad 场景会写入测试文本，Calculator 场景会点击按钮，Explorer 场景可能改变选择/焦点。

## 真机验证 Checklist

| 检查项 | 通过标准 | 失败时记录 |
|---|---|---|
| UIA availability | `listWindows()` 返回可见窗口；`readTree({ processId/windowId })` 返回 root 和控件节点 | `uia_tree_empty`、窗口 title、processId、depth/maxNodes |
| Win32 fallback | HWND-backed Button/Edit 有 `nativeWindowHandle`；UIA Pattern 缺失时可尝试 `BM_CLICK`/`WM_SETTEXT` | `native_hwnd_missing`、`win32_message_rejected`、目标 className |
| IAccessible wake | Chromium/Electron/自绘窗口在 UIA tree 过少时先尝试 IAccessible wake，再转视觉 fallback | `accessibility_wake_ignored`、render HWND class、tree node count |
| foreground/HID fallback | hotkey、HID click、SendKeys 都标记 `requiresForeground=true` 或 `fallbackUsed=foreground/hid` | `unexpected_background_success`、fallback path、verification image |
| 权限/完整性 | Provider 与目标 app integrity level 兼容；非 UAC secure desktop | `integrity_boundary`、elevated app、UAC prompt |
| 会话/远程桌面 | 桌面未锁定；RDP 未断开；多显示器/DPI 信息可记录 | `session_locked`、`rdp_capture_limited`、DPI/virtual origin |

## 场景矩阵与 capability 预期

| 场景 | 应用 | 操作 | backgroundRead | backgroundInvoke | backgroundType | requiresForeground | visionFallbackNeeded | fallbackUsed | verificationConfidence |
|---|---|---|---:|---:|---:|---:|---:|---|---|
| `win-list-windows` | Desktop session | `listWindows` | true | false | false | false | false | none | high |
| `win-read-uia-tree` | native app | `readTree` | true | false | false | false | false | none | high |
| `win-selector-find` | Calculator/Notepad | `findElement` | true | target-dependent | target-dependent | false | false | none | medium |
| `calculator-invoke-button` | Calculator | `executeAction.invoke` | true | true | false | false | false | `uia.InvokePattern` or `win32.BM_CLICK` | medium |
| `notepad-setvalue-type-verify` | Notepad | `executeAction.setValue` | true | false | true | false if ValuePattern/WM_SETTEXT works | false | `uia.ValuePattern.SetValue` or `win32.WM_SETTEXT` | high |
| `explorer-focus-select` | File Explorer | `executeAction.select/focus` | true | true if SelectionItem/Focus works | false | target-dependent | false | `uia.SelectionItemPattern` / `uia.SetFocus` / foreground | medium |

### Notepad 验证重点

- 首选：`ValuePattern.SetValue`，期望 `backgroundType=true`。
- Win32 fallback：HWND-backed `Edit` 可尝试 `WM_SETTEXT`。
- 动作后验证：读取 `value/text/name`，确认包含输入文本。
- 若现代 Notepad 自绘文本面不暴露 ValuePattern 且拒绝 `WM_SETTEXT`，必须返回 `requires_foreground` 或 `capability`，再显式走旧 `keyboard_type` foreground fallback。

### Calculator 验证重点

- 首选 selector：`automationId=num1Button`，备用 `name=One` + `controlType=Button`。
- 首选动作：`InvokePattern`，备用 `BM_CLICK`。
- 验证：按钮 dispatch 成功后重新读取 display/result 节点；若 display selector 因本地化不稳定，至少记录 action method 与 readTree 节点摘要，不做坐标点击替代。

### Explorer 验证重点

- 首选对象：`ListItem`、`TreeItem` 或 `DataItem`，如 Home/Desktop/Documents/Downloads/This PC。
- 首选动作：`SelectionItemPattern.Select`，备用 `SetFocus`。
- 验证：检查 `IsSelected` 或 `HasKeyboardFocus`；虚拟化或本地化导致 selector 找不到时记录 `AutomationId 不稳定/本地化`，避免坐标点击。

## 失败排障映射

| 症状 | 可能原因 | 应对 |
|---|---|---|
| UIA tree 为空或只有 Desktop root | 目标 app elevated；会话锁定；Chromium/Electron 未唤醒 accessibility；depth/maxNodes 过低 | 用 `processId/windowId` 重试；解锁桌面；检查完整性级别；先 IAccessible wake；必要时视觉 fallback |
| AutomationId 缺失或不稳定 | Windows/WinUI 版本差异；语言本地化；列表虚拟化回收 item | 使用 `name+controlType+className+path` 组合 selector；动作前刷新 tree；记录 ambiguity，不直接坐标点击 |
| `BM_CLICK`/`WM_SETTEXT` 无效 | 自绘控件；HWND 不是实际 child；跨完整性消息被拒绝；目标主动忽略消息 | 返回 `capability` 或 `requires_foreground`；优先 UIA Pattern；只显式 fallback 到 foreground/HID |
| 需要前台才能输入或热键 | global hotkey 只能前台；文本控件 focus-only；modal dialog 抢焦点 | 返回 `requires_foreground`；用旧 `window_focus` 前台化；动作后重新 readTree/value 验证 |
| HID/视觉 fallback 偏移 | DPI scaling；多屏负坐标；截图后窗口移动；RDP scaling | 优先 UIA bounds；fallback 前重新截图；记录 capture origin/DPI；不要使用 stale snapshot |
| RDP/锁屏失败 | 非交互桌面；screen capture 不可用；输入被抑制；RDP 断开 | 将环境标记为不支持 HID/vision；保持会话解锁；只运行 read-only semantic 检查；无验证不声明成功 |

## 验收记录模板

```json
{
  "timestamp": "2026-05-25T00:00:00.000Z",
  "machine": "Windows 11 23H2 / local unlocked desktop",
  "provider": "windows-uia-win32",
  "commands": [
    "npm run build",
    "node --test tests/windows-computer-use-fixture.test.mjs",
    "node scripts/windows-computer-use-smoke.mjs --read-only"
  ],
  "results": {
    "fixture": "pass",
    "listWindows": { "windowCount": 10 },
    "readTree": { "roots": 1, "nodes": 120, "patternNodes": 25 },
    "calculatorInvoke": { "ok": true, "method": "uia.InvokePattern", "verificationConfidence": "medium" },
    "notepadSetValue": { "ok": true, "method": "uia.ValuePattern.SetValue", "verificationPassed": true },
    "explorerSelect": { "ok": true, "method": "uia.SelectionItemPattern", "verificationConfidence": "medium" }
  },
  "fallbacks": [],
  "risks": []
}
```

## 与旧工具链的关系

本验证包不替代旧 MCP 工具测试。它用于验证 Windows provider 的 semantic path，并明确以下兼容关系：

- 旧 `uia_get_tree` / `uia_find_element` 可作为人工对照。
- 旧 `click_element` / `keyboard_type` 仍是显式 fallback 路径，不应被误标记为后台动作。
- 旧 screenshot/OCR/HID 能力只在 provider 返回 `vision_fallback_needed`、`requires_foreground` 或 `capability` 后介入。
