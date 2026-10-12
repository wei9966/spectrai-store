# E6 UI 层后台点击通道（UIA）实验

问的是：E4 证明合成笔点击必然抢前台之后，**改用 UI Automation 驱动控件能不能绕开抢前台？**

## 结论：**不能。UIA 动作照样抢前台，而且和 Chromium 无关**

| 通道 | 后台送达 | 光标 | 抢前台 |
|---|---|---|---|
| 键盘消息（E2） | ✅ | 0 | **不抢** ✅ |
| 合成笔点击（E3/E4/E5） | ✅ | 0 | **抢** ❌ |
| **UIA 动作（E6）** | ✅ | 0 | **抢** ❌ |

Chromium 上的 4 种动作（`Invoke`/`Toggle`/`SetValue`）全部生效、光标全 `0×0`、前台**全被抢**；关键对照是「只 park 不动作」时前台 `stable=true`。
UWP 计算器（非 Chromium、原生 UIA 支持）的 `Invoke` **也抢**——所以这是 UIA 动作的通性。

**实战含义**：文字输入走键盘通道可以做到零干扰；**点击/激活控件必然抢一次前台**，只能靠虚拟屏（E5）把视觉影响藏起来。UIA 的价值在**不受遮挡 + 不移动光标 + 定位精确**（HTML `id` 直接映射成 `AutomationId`），不在"不抢前台"。

完整数据、对照与局限见 [`REPORT.md`](REPORT.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `E6Uia.ps1` | 全部逻辑。`-Mode dump`（列 UIA 树）/ `-Mode list`（列窗口）/ `-Mode run`（执行动作 + 测量） |
| `e6-target.html` | 受控页面。窗口标题是读数：`E6-B<b> -C<chk> -V<len> -L<lnk> -P<ptr> -D<mdown>` |
| `E6WinFormsTarget.ps1` | 想用作非 Chromium 对照的 WinForms 窗口。**失败**：UIA 只把它识别成 `Pane` 且无可用 pattern（见报告 §5） |
| `e6-result-*.json` | 每次运行原始结果 |

## 要点参数

| 参数 | 说明 |
|---|---|
| `-TargetHwnd` / `-TargetClass` / `-TargetTitle` | 三种定位方式（按 hwnd 最稳；中文标题在命令行会被转码） |
| `-Element` | 目标元素的 UIA **Name**（先精确、再 contains） |
| `-Action` | `none`（**对照**）/ `auto` / `invoke` / `toggle` / `valueset` / `focus` / `click` |
| `-ParkProc` / `-NoPark` | 布置初始前台；park 失败会自动 `AttachThreadInput` 回退 |

`-Action none` 是**必测的对照**：它照样做全部 UIA 查找与属性读取，只是不执行动作。它证明前台变化来自"动作"而非"UIA 读取"或"park 不稳"。

## 两个必须知道的坑

1. **Chromium 必须带 `--force-renderer-accessibility`**，否则页面元素在 UIA 树里完全看不到。
2. **UIA 报的 `BoundingRectangle` 与真实窗口坐标差约 1116 px**（DPI 相关）。用 `Invoke` 不受影响；要用 UIA 做**坐标**点击必须先做换算。

## 安全边界

只读 + 标准 UIA 动作：`AutomationElement.FromHandle` / `FindAll` / `GetCurrentPattern` / `Invoke` / `Toggle` / `SetValue`，外加 `GetForegroundWindow` / `GetCursorPos` 采样。

**不含**：DLL 注入、全局钩子、`SendInput`、光标移动、注册表或系统设置修改。
