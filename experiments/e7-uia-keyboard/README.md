# E7 「UIA 定位 + 键盘输入」组合拳实验

验证：把 E6 的两条结论**组合**起来——UIA 做只读定位、键盘负责真正输入——能不能做到"文字进到指定控件且全程不抢前台"。

## 结论（补测后，均为有效环境的直接证据）

| 运行 | 焦点操作 | 焦点变化 | 字符进入 | 光标 | 前台 |
|---|---|---|---|---|---|
| CONTROL | 无 | 保持 `F:t1` | `T1:3→6` ✅ | `0×0` | **`stable=true` `distinct=1`** ✅ |
| **TAB** | Tab（等 1.5 s） | **`F:t1→F:t2`** ✅ | **`T2:0→3`** ✅ | `0×0` | **`stable=true` `distinct=1`** ✅ |
| TAB ×2 | Tab（等 1.5 s） | `F:t2→F:b1` ✅ | ❌（按钮无编辑目标） | `0×0` | **`stable=true` `distinct=1`** ✅ |

1. **`UIA SetFocus()` 会抢前台**（前台 SpectrAI → Chrome）。所以 **UIA 在这个组合里只能做只读定位**。
2. **键盘输入不抢前台**。
3. **Tab 移动焦点也不抢前台，之后字符能进目标控件**。

### 推荐形态

```
1. UIA 只读定位     -> 找元素、读 Name/AutomationId、确认可交互   （不抢前台）
2. 焦点用 Tab 移动  -> WM_KEYDOWN/WM_KEYUP VK_TAB，然后等 >=1.5s
3. 文字用 WM_CHAR   -> 逐字符投递                                （不抢前台）
4. 全程不调用任何 UIA 动作（不 SetFocus、不 Invoke）
```

**成立范围**：目标必须能**从当前焦点位置 Tab 到达**；Tab 环顺序不可控，需要时发多次并每步用 UIA 读 `activeElement` 确认。**Tab 不到或需要坐标精确定位时不适用。**

## 必须知道的三个坑

1. **投递前先 probe。** 本轮遇到过一个 Chrome 实例**完全不接受投递的键盘消息**：`ProbeWidgets` 三个候选全部 `changed=False`，Tab 不动焦点，字符不进去——而窗口状态一切正常（可见、未最小化、矩形正常、JS 活着）。换全新 profile 重启后立刻恢复正常。**根因未定。** 所以永远先用 `-ProbeWidgets` 确认实例健康，不要把"进程在、窗口在"当成"投递会被处理"。
2. **`-StepSettleMs` 默认 350 ms 会失败**，Tab 后要 `-StepSettleMs 1500`（焦点移动是异步的）。
3. **Tab 在页面边界会把焦点移出页面**（`activeElement` 变 `-`，焦点进浏览器 UI），并可能改变前台。**合成笔点击也会破坏 DOM 焦点**（点页面空白处 → `activeElement` 变 `-`）。

## 文件

| 文件 | 作用 |
|---|---|
| `E7Combo.ps1` | 全部逻辑。**分阶段记录前台**（park 后 / 聚焦后 / Tab 后 / 输入后），才能把前台变化归因到具体步骤 |
| `e7-target.html` | 受控页面。标题即读数：`E7 F:<focusedId> T1:<len> T2:<len> B:<clicks>` |
| `e7-result-*.json` | 每次运行原始结果，含各阶段前台快照 |

## 参数

| 参数 | 说明 |
|---|---|
| `-ProbeWidgets` | **先跑这个**：列出子窗口并探测哪个接收投递的按键 |
| `-InjectHwnd` | 指定注入的子窗口；默认自动选**面积最大**的那个（页面内容区） |
| `-FocusElement` | UIA 定位并按 Name 匹配，然后调 `SetFocus()`（**这一步会抢前台**） |
| `-SendTab` | 发送 VK_TAB 的 down/up |
| `-Text` / `-KeyMode` | 要发的文字 / `char`（默认）或 `keydown` 或 `both` |
| `-StepSettleMs` | **阶段间等待。Tab 后必须 ≥1500** |
| `-ParkProc` / `-NoPark` | 布置初始前台 |

## 安全边界

`PostMessage(WM_CHAR/WM_KEYDOWN/WM_KEYUP)` + UIA 只读定位（`FromHandle` / `FindFirst` / `Current`）+ `GetForegroundWindow`/`GetCursorPos` 采样。

**不含**：DLL 注入、全局钩子、`SendInput`、光标移动、注册表或系统设置修改。
