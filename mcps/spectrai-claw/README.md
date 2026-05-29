# SpectrAI Claw

跨平台桌面自动化 MCP Server。macOS 端已升级为 Node.js 长连接 Swift daemon，并在 v0.4 引入三路检测：**AX 主路 + Vision OCR 兵底 + CDP 浏览器专路**。

## 架构图

```text
AI → MCP Server (Node.js) → [zod] → DaemonClient (Unix socket)
                                              ↓
                                       Swift daemon
                                              ↓
                  ┌────────────────┼─────────────────┐
           ┌───┴───┐                  │                  │
           ▼       ▼                  ▼                  ▼
      AXorcist   ScreenCaptureKit  Vision (OCR/Rect)  CDP (WebSocket)
      增强 Web AX  截图              兵底补充             浏览器专路
```

## 三路识别模式（`describe_screen.mode`）

> 可选值：`auto` / `ax_only` / `ax_plus_vision` / `ax_plus_cdp` / `cdp_only` / `vision_only`

| mode | 适用 | 识别率 | 速度 | 依赖 |
|---|---|---|---|---|
| `ax_only` | 原生 AppKit / Tauri (Electron) | 80-95% | 极快 (~80ms) | AX 权限 |
| `ax_plus_vision` | Web 页面内容 / 后补 | 95%+ | 中 (~1s) | + Screen Recording |
| `ax_plus_cdp` | Chrome / Edge | 99% | 极快 (~30ms) | + Chrome `--remote-debugging-port` |
| `cdp_only` | Chrome 专项任务 | 99% | 极快 (~30ms) | + debug port |
| `vision_only` | 原本不提供 AX 的游戏 / Java app | 70-85% | 中 (~1s) | + Screen Recording |
| `auto` | 默认 | 自适应 | 自适应 | - |

## 实测性能（主会话）

| 场景 | mode | 元素识别数 | 说明 |
|---|---|---|---|
| SpectrAI (Tauri) | ax_only | 124 (vs 8) | AXManualAccessibility 唤醒后取醒 web AX |
| Chrome 首页 | ax_only | 48 (vs 41) | Chrome 主线禁用了唤醒 API，有限 |
| Chrome 首页 | ax_plus_vision | 140 | Vision 补 92 个网页元素（含主 CTA 按钮） |

以上数据与 v0.4 集成验证一致：Tauri/Electron 提升明显，Chrome 在 AX 主线受限时依赖 Vision/CDP 补齐。

## CDP 浏览器启用说明

```bash
# 1. 退出 Chrome
# 2. 启动时加参数
open -a "Google Chrome" --args --remote-debugging-port=9222

# 3. 验证
curl http://localhost:9222/json | head -20
```

启用后 `ax_plus_cdp` 模式会自动检测。

## 安装

### 从 npm 安装（推荐）

本包是标准 stdio MCP server，入口即 server，无需子命令，`npx` 直接拉起：

```bash
npx spectrai-claw
```

在 MCP 客户端（Claude Desktop / Claude Code 等）中配置：

```json
{
  "mcpServers": {
    "spectrai-claw": {
      "command": "npx",
      "args": ["-y", "spectrai-claw"]
    }
  }
}
```

Windows 上部分 MCP 客户端无法直接 spawn `npx`（PATH/PATHEXT 解析问题），需经 `cmd /c` 拉起：

```json
{
  "mcpServers": {
    "spectrai-claw": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "spectrai-claw"]
    }
  }
}
```

> Windows 端为纯 Node 实现，`npx spectrai-claw` 即可运行，无需原生编译；
> macOS 端首次运行会自动构建/拉起 Swift daemon（需 Xcode Command Line Tools）。

### 从源码构建

```bash
cd mcps/spectrai-claw
npm install
npm run build:all
```

### 运行要求

**macOS**

- macOS 14+
- Node.js 18+
- Xcode Command Line Tools（或完整 Xcode）
- 首次运行会触发系统权限请求：
  - Screen Recording
  - Accessibility

**Windows**

- Windows 10 / 11
- Node.js 18+
- 纯 Node 实现，无需原生编译、无需 Xcode/Swift
- 依赖系统自带 PowerShell + UI Automation（UIA），无额外安装

## MCP 工具（macOS daemon 路径）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `describe_screen` | 截图 + UI 元素识别 + SoM 标注 | `target?`, `annotated?`, `allow_web_focus?`, `mode?` |
| `click` | 点击元素或坐标 | `element_id`（优先）, `snapshot_id?`, `x?`, `y?` |
| `type_text` | Unicode 输入（中文可用） | `text`, `element_id?`, `snapshot_id?` |
| `hotkey` | 发送组合键 | `keys[]`, `hold_ms?` |
| `scroll` | 滚轮滚动 | `direction`, `amount`, `x?`, `y?` |
| `list_apps` | 列出运行中的应用 | - |
| `activate_app` | 激活应用到前台 | `bundle_id` 或 `name` |

### v0.4+ 原生 AX 动作优先

`click` / `type_text` 在传入 `snapshot_id + element_id` 时会优先使用 macOS Accessibility 原生动作：

- 左键单击且无修饰键时，先尝试 `AXUIElementPerformAction(kAXPressAction)`，成功则不会移动真实鼠标光标。
- 文本输入命中 `AXTextField` / `AXTextArea` / `AXSearchField` 等输入元素时，先尝试 `AXFocused + AXSetValue(kAXValueAttribute)`；`clear_existing=true` 直接替换，默认追加现有值。
- AX 元素不可重找、已 stale、action/value 不可用或失败时，自动回退到原有 CGEvent 坐标点击 / 键盘输入。

这也是接近 Codex App Computer Use “后台式 / 无光标移动”体验的关键：识别仍依赖 AX 树/截图，执行优先走程序化 UI action。

## MCP 工具（Windows 路径）

Windows 端为纯 Node 实现，工具直接经 PowerShell + UIA 操作，无 daemon。推荐工作流：`screenshot` → `click_element(number)` / `keyboard_type`，复杂区域用 `zoom_screenshot` + `mouse_click` 精定位。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `screenshot` | ★ STEP 1：全屏截图 + UIA/OCR 元素识别 + 编号标注 | `annotate?` |
| `click_element` | ★ STEP 2（最佳）：按编号点击；UIA 原生动作（Invoke/Toggle/Selection/ExpandCollapse/Focus）优先，失败回退 HID 点击 + 验证截图 | `number` |
| `zoom_screenshot` | ★ STEP 2：区域放大 + 坐标网格，便于读取精确坐标 | `x`, `y`, `width`, `height` |
| `mouse_click` | ★ STEP 3：按精确坐标点击（配合 `zoom_screenshot`） | `x`, `y`, `button?` |
| `vision_click` | OCR/vision 兜底：按可见文本点击，用于 UIA 不可用场景（Canvas / Electron / 游戏 / RDP） | `text` |
| `keyboard_type` | 输入文本（支持 Unicode）；UIA `ValuePattern.SetValue` 优先，回退 SendKeys | `text`, `element_id?` |
| `keyboard_press` | 按单个键（Enter / Tab / Escape / F1-F12 等） | `key` |
| `keyboard_hotkey` | 组合键（Ctrl+C / Alt+F4 / Ctrl+Shift+S 等） | `keys` |
| `mouse_move` / `mouse_scroll` | 移动光标 / 滚轮滚动 | `x`, `y` / `direction`, `amount` |
| `uia_find_element` / `uia_get_tree` | 进阶：按 name/automationId/className 查 UIA 元素 / 取窗口 UI 树 | `name?`, `automationId?` |
| `window_list` / `window_focus` / `window_close` | 列出 / 聚焦 / 关闭窗口 | `title?`, `handle?` |
| `get_screen_info` | 屏幕分辨率、DPI、缩放因子 | - |
| `screenshot_click` | ⚠️ 低优先：按上次截图的百分比位置点击，不精确，仅作兜底 | `x_pct`, `y_pct` |

> Windows 操作准确性（UIA 语义过滤 / OCR 锚定 UIA / 动作后验证）见下方「已知局限 → Windows 操作准确性改造」。

## daemon 管理

- 自动拉起：`DaemonLifecycle.ensure()` 会先尝试连接，失败时自动 spawn daemon。
- 手动启动：

```bash
./src/swift-helper/.build/release/spectrai-claw-helper daemon run --socket <path>
```

- 默认 socket：`~/Library/Application Support/spectrai-claw/claw.sock`
- 健康检查（推荐）：

```bash
node scripts/smoke-daemon.mjs
```

- 低层协议见：`docs/ipc-protocol.md`

## 综合测试

```bash
# 单测（mock socket）
npm run test:daemon-client

# E2E（真实 spawn daemon）
npm run test:e2e
```

## 已知局限

- AXManualAccessibility 在 Chrome 主线被限制（issue 37465），Tauri/Electron 仍然有效
- Vision OCR 冷启约 500ms，后续走 cache；且需要 Screen Recording 权限
- CDP 需手动启用 debug port，不能动态唤醒已启动的 Chrome
- 仅 macOS 14+（依赖 ScreenCaptureKit）
- Windows 端仍为旧路径（未迁移到 Swift daemon 架构），但 `click_element` / `keyboard_type` 已升级为 UIA 原生动作优先：优先尝试 Invoke/Toggle/Selection/ExpandCollapse/Focus 与 ValuePattern.SetValue，失败自动回退 HID 鼠标事件 / SendKeys。

### Windows 操作准确性改造（screenshot 标注链路）

`screenshot(annotate=true)` / `zoom_screenshot` 的元素识别已做语义增强：

- **UIA 候选过滤打分**：枚举时多采 `IsEnabled` / `IsOffscreen` 与控件 pattern（Invoke/Toggle/SelectionItem/ExpandCollapse/Value），过滤离屏元素与无 pattern 的纯 Image 噪声，并按「可操作性」把可原生操作的元素排在标注列表前列（徽章编号保持稳定，`click_element(number)` 不受影响）。
- **OCR 锚定 UIA**：OCR 兜底文本若落在某带 pattern 的 UIA 元素 bounds 内，则用该原生元素替代裸 OCR 坐标（`Src=OCR_UIA`），从而走 UIA pattern 动作而非盲点坐标；命不中才保留 OCR 坐标兜底。兜底链为 UIA pattern → UIA 坐标 → OCR 坐标 → vision。
- **动作后验证**：UIA 原生动作执行后回读目标元素状态（ToggleState / ExpandCollapseState / IsSelected / Value / 焦点），在返回里附 `verify=verified | state_not_changed | needs_resnapshot | uncertain`，便于上层判断动作是否真正生效。

> 上述链路依赖本机 Windows 桌面会话的 PowerShell + UIA，需在本地直连 MCP 验证真机行为。
