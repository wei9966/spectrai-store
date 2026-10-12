# E6 UI 层后台点击通道（UIA）实验结果

- 日期：2026-10-12
- 脚手架：`E6Uia.ps1`（UIA 定位与驱动 + 原始 USER32 测量）、`e6-target.html`（受控页面）、`E6WinFormsTarget.ps1`（失败对照物，见 §5）
- 数据：同目录 `e6-result-*.json`
- 前置：E3/E4 已证明合成笔点击**必然**把 Chromium 拉到前台，E5 装了虚拟屏

## 1. 问题

E4 的结论是：对真实的 Chromium/Electron 窗口，合成笔点击一定会抢前台，`WS_EX_NOACTIVATE` 挡不住。那么**换到 UI 层**——用 UI Automation 直接驱动控件（`InvokePattern.Invoke()` / `TogglePattern.Toggle()` / `ValuePattern.SetValue()`）——能不能在不激活窗口的前提下完成点击？

（这条通道也是 Claw 驱动传统 Win32 控件时已经在用的路径，所以值得单独验证。）

## 2. 结论：**不行。UIA 动作同样会抢前台，而且与 Chromium 无关**

| 通道 | 后台送达 | 光标位移 | 抢前台 |
|---|---|---|---|
| 键盘消息（E2） | ✅ | 0 | **不抢** ✅ |
| 合成笔点击（E3/E4/E5） | ✅ | 0 | **抢** ❌ |
| **UIA 动作（E6）** | ✅ | 0 | **抢** ❌ |

**三方对照下，只有键盘通道不抢前台。任何形式的"点击/驱动控件"都会抢前台。**

## 3. Chromium 上的结果（页面在虚拟屏，全部为合法后台态）

`park=ok`、`targetWasForeground=false`、`conclusive=true`，光标全程 `0×0`。

| 元素 | 动作 | 生效 | 页面读数变化 | 前台 |
|---|---|---|---|---|
| `E6 Button A`（Button, `btnA`） | `InvokePattern.Invoke()` | ✅ | `B0→B1` | **抢**（`distinct=3`） |
| `E6 Check A`（CheckBox, `chkA`） | `TogglePattern.Toggle()` | ✅ | `C0→C1` | **抢**（`distinct=2`） |
| `E6 Text A`（Edit, `txtA`） | `ValuePattern.SetValue('E6TEXT')` | ✅ | `V0→V6` | **抢**（`distinct=2`） |
| `E6 Link A`（Hyperlink, `lnkA`） | `InvokePattern.Invoke()` | ✅ | `L0→L1` | **抢**（`distinct=2`） |
| 对照：只 park，**不执行任何动作** | — | — | 无变化 | **`stable=true`**，两次 |

最后一行是关键对照：**只做 UIA 的元素查找与属性读取时前台完全不变**（脚本会做 `FromHandle`、`FindFirst`、6 次 `GetCurrentPattern` 探测），所以抢前台是**动作**造成的，不是 UIA 的读取造成的，也不是 park 不稳。

另外，`Invoke` 与 `Toggle` 会在页面上产生 `pointerdown`/`mousedown` 计数（`P`/`D` 各 +1），而 `SetValue` 不会——说明 **Chromium 把 UIA 动作实现成了模拟点击**。即使如此，**不涉及鼠标的 `SetValue` 也一样抢前台**，所以这不是"模拟点击激活窗口"能解释的。

## 4. 非 Chromium 对照：UWP 计算器（决定性问题）

Chromium 抢前台可能只是它自己的实现问题。为了判断这是不是 UIA 的通性，换了一个有**原生 UIA 支持**的目标：Windows 计算器（UWP）。

| 元素 | 动作 | 生效 | 读数 | 光标 | 前台 |
|---|---|---|---|---|---|
| `Seven`（Button, `num7Button`） | `InvokePattern.Invoke()` | ✅ | `Display is 0 → 7` | `0×0` | 该次 park 失败（见 §5） |
| `Three` | `Invoke` | ✅ | 追加到显示区 | `0×0` | **抢**（`distinct=3`，记事本 → 计算器） |

`Three` 那次是有效的后台运行（`targetWasForeground=false`）：操作生效（显示区继续增长到 `78,901,234`），光标没动，但**计算器把自己拉回了前台**。

**所以"UIA 动作抢前台"不是 Chromium 的特性，是 UIA 动作的通性。**

## 5. 已知缺陷与局限

- **计算器的 park 一直失败**：对 UWP 窗口，`SetForegroundWindow` / `SwitchToThisWindow` 都抢不过它（前台锁），`AttachThreadInput` 回退也无效。最后改用合成笔点击记事本把记事本顶到前台，让计算器自然落到后台——**方法有效但绕**。因此计算器组只有 1 次有效的后台运行（`Three`），样本太少。
- **WinForms 对照物不合格**：想用 WinForms 按钮做对照，结果 UIA 只把它识别成 `Pane` 且**不支持任何 pattern**（`GetCurrentPattern` 全部抛"不支持的模式"）。原因是 WinForms 的按钮不是原生 Win32 `BUTTON` 控件，UIA 支持依赖 MSAA 桥接，而 .NET 的 UIA 客户端里 `LegacyIAccessiblePattern` 类型不存在（我在脚本里已改成按数字 ID 查表，仍拿不到）。**这个对照没做成，如实记录。**
- **一次未能复现的光标位移**：在计算器组之前的一次记事本点击中，采样窗口内捕捉到光标从 `(381,1078)` 移到 `(2684,479)`。随后**同一命令重复 6 次全部 `dx=dy=0`**，Python 读取的地面真值也与脚本一致。E1 也遇到过一次同类情况（`144526`，`dx=36 dy=46`）。我的采样只覆盖单次运行的那 1–2 秒，**跨运行的移动无法归因**（很可能是用户自己动鼠标）。记录为**未复现异常，不归因于合成笔**。
- **UIA 坐标与窗口坐标不一致**：按钮的 `BoundingRectangle` 报 `[5360,179 – 5513,215]`，而窗口本身在 `[4244,20 – 4884,520]` —— 差约 1116 px，是 DPI 相关。本实验全用 `Invoke`（不依赖坐标）所以没受影响，但**如果要用 UIA 做坐标点击，必须先解决这个换算**。
- **只测了 4 种 pattern**（Invoke/Toggle/Value/ScrollItem）与 2 类目标（Chromium、UWP）。`SelectionItem`、`ExpandCollapse`、`RangeValue` 等未测。
- **未测"是否真的无法避免"**：没有尝试在 UIA 动作前后立刻压回前台这类补救手段。

## 6. 对研究方向的影响

1. **"UI 层点击通道"这条假设被证伪。** E4 之后我提出的"改用 UIA 绕开抢前台"不成立——UIA 动作照样抢，连 UWP 也抢。
2. **键盘 + 点击要分开设计**：
   - **文字输入**：走键盘消息通道（E2），可做到真正零干扰；
   - **点击/激活控件**：**必然**抢一次前台，没有已知的纯软件绕法（本实验范围内）。
3. **虚拟屏（E5）因此从"锦上添花"变成"必要"**：既然点击必然抢前台，唯一能让用户察觉不到的办法就是让被抢前台的窗口待在一块**看不见的屏**上。
4. **UIA 仍然有价值**，只是价值不在"不抢前台"，而在：**不受遮挡影响**（不需要窗口在最上层）、**不移动光标**、**定位精确**（HTML `id` 直接映射成 `AutomationId`，比坐标可靠）。把 UIA 当作"比合成笔更可靠的定位与驱动方式"，而不是"非激活通道"，才是正确用法。

## 7. 复现

```bash
cd experiments/e6-uia-invoke

# 起目标页（务必带 --force-renderer-accessibility，否则 Chromium 不暴露页面元素）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir=%TEMP%\e6profile --no-first-run --force-renderer-accessibility \
  --window-position=3860,20 --window-size=640,500 \
  "file:///<abs-path>/experiments/e6-uia-invoke/e6-target.html"

# 看 UIA 树
powershell -NoProfile -ExecutionPolicy Bypass -File E6Uia.ps1 -Mode dump -TargetTitle 'E6-'

# 跑一个动作（后台 + 测量）
powershell -NoProfile -ExecutionPolicy Bypass -File E6Uia.ps1 -Mode run \
  -TargetTitle 'E6-' -Element 'E6 Button A' -Action invoke -ParkProc SpectrAI

# 关键对照：只 park 不动手
powershell -NoProfile -ExecutionPolicy Bypass -File E6Uia.ps1 -Mode run \
  -TargetTitle 'E6-' -Element 'E6 Button A' -Action none -ParkProc SpectrAI
```

## 8. 建议的下一步

1. **补做合格的非 Chromium 对照**：WinForms 不行，需要一个**原生 Win32 按钮**（用 C# 建窗口 + `BUTTON` 子控件），或另一个 UWP 应用，把计算器组的样本补到 5 次以上。
2. **验证"键盘 + UIA 定位"的组合**：UIA 负责找到目标并确认它可交互，键盘负责真正输入文字——这条组合拳可能已经够用（文字零干扰 + 点击接受一次前台切换）。
3. **把虚拟屏纳入默认部署**：既然点击必然抢前台，把目标放虚拟屏应当成为默认策略而不是可选项。
4. **评估 UIA 的坐标换算**：如果要走坐标点击，先把 DPI 换算搞对。
