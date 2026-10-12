# Windows 后台输入方案评估：合成笔 + 虚拟屏

- 日期：2026-10-12
- 性质：**评估**（只分析，未改任何实现代码）
- 触发它的实测：`tests/windows-invoke-foreground-side-effect.test.mjs`
- 实验依据：本仓库外的 E1–E7 系列实测（结论摘录见下）

## 1. 问题陈述

当前 Windows provider 的目标是 README 里写的「**后台式 / 无光标移动**」。实测下来**只达成了后半句**：

| 目标 | 现状 | 依据 |
|---|---|---|
| 无光标移动 | ✅ 达成 | 点击优先走 UIA pattern；HID 仅作为显式 fallback |
| 后台式（不打扰用户） | ❌ **未达成** | UIA `Invoke`/`Toggle`/`SetValue`/`SetFocus` 都会把目标窗口拉到前台 |

这份文档评估两条能真正补上「后台式」的通道：**合成笔**和**虚拟屏**。

## 2. 实测证据（本评估的依据）

| 实验 | 结论 |
|---|---|
| E3 | 合成笔命中**精确到像素**（请求 `2700,350` 收到 `L2700:350`），连点逐次一致；**光标全程 0×0** |
| E4 | 跨进程加 `WS_EX_NOACTIVATE` **挡不住** Chromium：缓解组与对照组表现完全相同（前台 SpectrAI → Chrome） |
| E5 | IddCx 虚拟屏可用：`screens 2 → 3`；**彻底解决遮挡**（副屏上 `preflight.receiver=SodaMusic(isTarget=false)` 点击丢失 vs 虚拟屏上 `isTarget=true` 必中）；安装需提权且需用户确认驱动发布者 |
| E6 | UIA `Invoke`/`Toggle`/`SetValue` 在 Chromium **和 UWP 计算器**上**全部抢前台**；只读的 UIA 读取不抢（`no-action` 对照 `stable=true`） |
| E6 | **合成笔受 UIPI 约束**：对提升权限的窗口，注入返回 `ok` 但**毫无反应** |
| E7 | UIA `SetFocus` 抢前台；**键盘消息（WM_CHAR）与 Tab 移焦不抢前台**（前台 `distinct=1` 全程不变） |
| 本仓库回归测试 | 上述副作用在 **Claw 自己的 WinForms fixture** 上复现：`method=uiaInvoke`，前台从 `Claw FgCheck Front` 变成 `Fg Side Effect` |

## 3. 方案 A：合成笔（`CreateSyntheticPointerDevice` + `InjectSyntheticPointerInput`）

### 能拿到什么

- **不移动系统光标**（`SendInput` 做不到这一点：绝对坐标注入必然移动光标）。
- **不依赖目标暴露 UIA pattern**。当前 UIA 路径对没有 pattern 的控件只能降级到 HID；合成笔可以直接按坐标点。
- 命中精度与 `SendInput` 同级（实测逐像素一致），且失败时不需要 `SetCursorPos` 兜底。

### 限制（必须写进能力报告）

1. **仍然会抢前台**。E4 证明 `WS_EX_NOACTIVATE` 挡不住应用自己的激活行为，所以合成笔**不能**单独解决"后台式"。
2. **遮挡敏感**。点到被别的窗口覆盖的位置，点击会落到上层窗口（E3/E4 都踩过）。
3. **UIPI**。对提升权限的目标无效（E6 实测）。这是硬边界，检测不出来只能靠 `IsWindowEnabled`/完整性级别预判。

### 接入点（代码级）

- `src/helpers/PersistentShell.ts`：新增 `SendPen`，与现有 `SendMouse` 并列（约 60 行 C#，可直接照搬 E4 的实现）。
- `src/computer-use/providers/windows/provider.ts` `actionMatrix()`：新增一条 `penClick`，诚实标注 `background: false`（会抢前台）、`requiresForeground: false`。
- **同时建议**：把 `clickFallback`（HID `mouse_event`）降为"最后手段"——它在每个维度上都不如合成笔（移动光标、精度更差）。

### 代价

小。没有新依赖，`InjectSyntheticPointerInput` 自 Win10 1809 起就在 `user32` 里（Claw 已要求 Win10/11）。

## 4. 方案 B：虚拟屏（IddCx 虚拟显示器）

### 能拿到什么

- **彻底解决遮挡**（E5 实测）：虚拟屏上没有用户的窗口，点击不会被截走。
- **把"抢前台"的伤害降到最低**：窗口在一块用户看不见的屏上，抢前台时不会有窗口跳到用户脸上。

### 限制

1. **安装需要管理员权限**，并且因为是第三方签名驱动，会弹「Windows 安全中心」要求用户确认发布者（E5 全程实录）。
2. **多一个系统级依赖**。Claw 是 npm 包，**不应该**自带或静默安装显示驱动。
3. 默认分辨率 800×600（可通过 `vdd_settings.xml` 配置）。

### 接入点建议

**不要**在 Claw 进程里实现驱动安装。建议：

- 新增只读的 `list_displays`（`EnumDisplayMonitors`），让 Agent 知道有几块屏、各自 bounds。
- 新增 `move_window_to_display(windowId, displayIndex)`，把目标窗口搬到虚拟屏上（`SetWindowPos`）。
- 驱动安装留给用户/安装器，Claw 只**检测并利用**已存在的虚拟屏。
- 能力报告里加一个 `virtualDisplayAvailable` 标志。

### 代价

中等：驱动分发/安装的责任、用户信任成本、以及"目标窗口要先搬过去再操作"的编排复杂度。

## 5. 建议的落地顺序（分层）

```
第 0 步（必须先做）：让能力报告诚实
  - actionMatrix / backgroundInvoke 增加"会改变前台"这一维度
  - 这是 B1 的修复，不改行为、零风险，但能让上层决策正确

第 1 步：合成笔替代 HID fallback
  - 收益立刻可见（不再移动光标、不依赖 pattern）
  - 但必须同时标注 UIPI 与遮挡两条限制

第 2 步：虚拟屏按"用户已有则利用"的方式接入
  - list_displays + move_window_to_display
  - 不承担驱动安装责任

第 3 步：编排层
  - 需要真正不打扰用户时：搬到虚拟屏 → 用合成笔/UIA 操作
  - 只需要填字时：键盘消息 + Tab（E7 证明这条不抢前台，成本最低）
```

**为什么把"诚实标注"排在第 0 步**：现在 `backgroundInvoke: true` 会让上层以为"后台操作不会打扰用户"，于是可能在用户正在打字时点按钮——实际结果是夺走焦点。这个错误决策的代价比"少一个注入通道"大得多。

## 6. 不推荐的做法

- **`WS_EX_NOACTIVATE`**：E4 证明对真实应用（Chromium）无效，只对自己创建的窗口有效。不要把它当通用解。
- **MCP 层模拟全局热键**：现有实现已经明确拒绝（`hotkey` 的 `unsupportedReason`），这个判断是对的，保持。
- **依赖 HID 作为主路径**：会移动用户光标，是"无光标移动"目标的反面。

## 7. 一句话结论

**合成笔能买到"不移动光标 + 不依赖 pattern"，买不到"不打扰用户"；虚拟屏才能买到"不打扰用户"，但要用户付出安装驱动的代价。二者叠加 + 能力报告如实标注副作用，是当前唯一能真正达成 README 里"后台式"目标的组合。**
