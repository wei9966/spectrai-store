# E7 「UIA 定位 + 键盘输入」组合拳实验

验证：把 E6 的两条结论**组合**起来——UIA 做只读定位、键盘负责真正输入——能不能做到"文字进到指定控件且全程不抢前台"。

## 结论

| 测试 | 焦点操作 | 字符进入 | 光标 | 前台 |
|---|---|---|---|---|
| T1 基线 | 无（`autofocus`=t1） | t1 ✅ | `0×0` | **稳定** ✅ |
| T2 | **UIA `SetFocus`(t2)** | t2 ✅ | `0×0` | **被抢** ❌ |
| R2 / TEST A | **Tab**（等 1.5 s） | **t2 ✅** | `0×0` | ⚠️ 环境无前台窗口，测量无效 |

1. **键盘输入本身不抢前台**（T1 有效证据）。
2. **UIA `SetFocus()` 会抢前台**（T2 有效证据：前台 SpectrAI → Chrome）。所以 **UIA 在这个组合里只能做只读定位**。
3. **Tab 可以移动焦点，之后字符能进目标控件**，但**必须等 ≥1.5 s**（350 ms 会丢字符，焦点移动是异步的）。

### 推荐形态

```
1. UIA 只读定位     -> 找元素、读 Name/AutomationId、确认可交互   （不抢前台）
2. 焦点用 Tab 移动  -> WM_KEYDOWN/WM_KEYUP VK_TAB，然后等 >=1.5s
3. 文字用 WM_CHAR   -> 逐字符投递                                （不抢前台）
4. 全程不调用任何 UIA 动作（不 SetFocus、不 Invoke）
```

**成立范围**：目标必须能**从当前焦点位置 Tab 到达**。Tab 环顺序不可控、远了要多按几次；**不可 Tab 到达或需要坐标精确定位时，这条路不适用**。

## 必须知道的坑

1. **`-StepSettleMs` 默认 350 ms 会失败**，Tab 后要 `-StepSettleMs 1500`。
2. **Tab 在页面边界会把焦点移出页面**（`activeElement` 变 `-`，焦点进浏览器 UI），并可能改变前台。自动化时要算准 Tab 次数，或每步用 UIA 读一次 `activeElement` 确认。
3. **本实验晚期的"前台不变"不算证据**：系统中途真实失去了前台窗口（`GetForegroundWindow()` 恒为 0，非锁屏），`park`/`AppActivate`/合成笔/最小化还原都救不回来。详见 [`REPORT.md`](REPORT.md) §4。

## 文件

| 文件 | 作用 |
|---|---|
| `E7Combo.ps1` | 全部逻辑。**分阶段记录前台**（park 后 / 聚焦后 / Tab 后 / 输入后），才能把前台变化归因到具体步骤 |
| `e7-target.html` | 受控页面。标题即读数：`E7 F:<focusedId> T1:<len> T2:<len> B:<clicks>` |
| `e7-result-*.json` | 每次运行原始结果，含各阶段前台快照 |

## 参数

| 参数 | 说明 |
|---|---|
| `-ProbeWidgets` | 列出子窗口并探测哪个接收投递的按键（本机三个 RenderWidgetHost **都**能收） |
| `-InjectHwnd` | 指定注入的子窗口；默认自动选**面积最大**的那个（页面内容区） |
| `-FocusElement` | UIA 定位并按 Name 匹配，然后调 `SetFocus()`（**这一步会抢前台**） |
| `-SendTab` | 发送 VK_TAB 的 down/up |
| `-Text` / `-KeyMode` | 要发的文字 / `char`（默认，E1/E2 做法）或 `keydown` 或 `both` |
| `-StepSettleMs` | **每个阶段之间的等待。Tab 后必须 ≥1500** |
| `-ParkProc` / `-NoPark` | 布置初始前台 |

## 安全边界

`PostMessage(WM_CHAR/WM_KEYDOWN/WM_KEYUP)` + UIA 只读定位（`FromHandle` / `FindFirst` / `Current`）+ `GetForegroundWindow`/`GetCursorPos` 采样。

**不含**：DLL 注入、全局钩子、`SendInput`、光标移动、注册表或系统设置修改。
