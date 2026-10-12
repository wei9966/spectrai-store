# E7 「UIA 定位 + 键盘输入」组合拳实验结果

- 日期：2026-10-12
- 脚手架：`E7Combo.ps1`（UIA 定位 + 键盘投递 + **分阶段**前台测量）、`e7-target.html`
- 数据：同目录 `e7-result-*.json`
- 前置：E2（键盘通道不抢前台）、E6（UIA 动作抢前台）

## 1. 问题

E6 证明 UIA 动作会抢前台，键盘通道不会。那么把两者**组合**起来，能不能做到"把文字送进指定的那个控件，而全程不抢前台"？

组合的关键未知是：**UIA `SetFocus()` 会不会抢前台？** 如果会，UIA 就只能做只读定位，焦点必须改用键盘（Tab）移动。

脚本的设计要点是**在每个阶段后各读一次前台**（park 后 / 聚焦后 / Tab 后 / 输入后），这样才能把前台变化归因到具体某个步骤，而不是靠总统计去猜。

## 2. 结论

| 测试 | 焦点操作 | 输入 | 焦点到达 | 字符进入 | 光标 | 前台 |
|---|---|---|---|---|---|---|
| **T1 基线** | 无（`autofocus` = t1） | `WM_CHAR`×3 | — | **t1 ✅** | `0×0` | **稳定（SpectrAI）** ✅ |
| **T2** | **UIA `SetFocus`(t2)** | `WM_CHAR`×3 | t2 ✅ | **t2 ✅** | `0×0` | **被抢（SpectrAI → Chrome）** ❌ |
| T3 | UIA `SetFocus`(t1) + Tab | `WM_CHAR`×3 | t2 ✅ | ❌（350 ms 等待不够） | `0×0` | 不变（当时 Chrome 已在前台） |
| R2 | Tab（等待 1.5 s） | `WM_CHAR`×3 | t2 ✅ | **t2 ✅** | `0×0` | ⚠️ 无前台窗口，测量无效 |
| TEST A | Tab（等待 1.5 s） | `WM_CHAR`×3 | t2 ✅ | **t2 ✅** | `0×0` | ⚠️ 同上 |
| T4 / T6 | Tab ×2 | `keydown`+`char` | b1 / **移出页面** | ❌（无可编辑目标） | `0×0` | T6 有变化（焦点出页面） |

**三条结论：**

1. **键盘输入本身不抢前台**（T1，有效证据：`park=ok`、前台 `48892734`=SpectrAI、`distinctDuringRun=1`、字符进了 t1）。
2. **UIA `SetFocus()` 会抢前台**（T2，有效证据：park 后前台是 SpectrAI `48892734`，`SetFocus` 之后变成 Chrome `10490422`）。所以 **UIA 在这个组合里只能做只读的定位/校验**，不能用来移动焦点。
3. **Tab 键可以移动焦点，并且之后字符能进目标控件**（R2 / TEST A：`F:t1 → F:t2`，`T2:0 → T2:3`）。但有个**操作细节**：Tab 之后必须等足够久（实测 **350 ms 不够、1500 ms 够**），否则字符会被丢弃。焦点移动是异步的（浏览器→IPC→渲染进程改焦点→AX/UIA 树更新）。

## 3. 推荐的组合形态

```
1. UIA 只读定位     : 找到目标元素、读 Name / AutomationId / ControlType、
                      确认它可交互        <- 不抢前台（E6 的 no-action 对照已证明）
2. 焦点用 Tab 移动  : PostMessage(WM_KEYDOWN/WM_KEYUP, VK_TAB)
                      然后等待 >= 1.5s
3. 文字用 WM_CHAR   : 逐字符投递         <- 不抢前台（E2 + T1 证明）
4. 全程不调用任何 UIA 动作（不 SetFocus、不 Invoke）
```

**成立范围（重要）**：这条路径要求目标**能从当前焦点位置"Tab 到达"**。焦点顺序不可控、目标可能在 Tab 环的靠后位置，需要发多次 Tab。**如果目标无法用 Tab 到达，或者需要精确定位到页面上的某个坐标，这套组合就不适用**——那种情况下只能接受一次前台切换（或依赖 `autofocus` 这类页面自身行为）。

## 4. 已知缺陷与局限

- **晚期的"前台不变"测量无效**：从 T3 之后的某个时间点开始，系统**真实地失去了前台窗口**——`GetForegroundWindow()` 恒返回 `0`。我确认过不是锁屏（`LogonUI` 进程数为 0），也确认过我们在输入桌面上（`OpenInputDesktop` 返回非 0）；尝试了 `park`（含 `AttachThreadInput` 回退）、`WScript.Shell.AppActivate`、**合成笔点击**、窗口最小化+还原，**都无法重新建立前台窗口**。
  - 因此 R2 / TEST A / TEST C 那几次报告里的 `foreground stable=True` 是**平凡成立的**（本来就没有前台窗口），**不能算作"Tab 不抢前台"的证据**。
  - 「Tab 不抢前台」目前只有**间接证据**：T3 里 Tab 前后前台都是 `10490422`（未变），加上 E2 已证明键盘消息不抢前台。**没有在有效前台环境下直接测到。**
  - 这是**环境问题**，不是脚本问题：同一段时间里焦点移动、字符投递、光标测量都工作正常。
- **T3 的失败是等待时间问题，不是路径问题**：T3 用默认 `-StepSettleMs 350` 导致字符被丢弃；R2 用 1500 ms 就成功。这条容易误判，已在上面点明。
- **Tab 在页面边界会把焦点移出页面**：T6 里从最后一个页面元素再按 Tab，`document.activeElement` 变成 `-`（焦点去了浏览器 UI），并伴随前台变化。自动化时必须把"Tab 次数"算准，或者每步都用 UIA 读一次 `activeElement` 来确认。
- **只测了 Chromium**。UWP / 传统 Win32 的 Tab 行为没测（UWP 的 UIA 动作同样抢前台，见 E6，但 Tab 路径未验证）。
- **未测多字段/多 Tab 的完整表单流程**，只测了"移动一格并输入"。
- `--force-renderer-accessibility` 会让渲染进程变慢，Tab 后的等待时间在普通模式下可能更短——本实验的 1.5 s 是**这个模式下的保守值**。

## 5. 复现

```bash
cd experiments/e7-uia-keyboard

# 起目标页（页面有两个输入框 t1/t2 和一个按钮，t1 带 autofocus）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir=%TEMP%\e7profile --no-first-run --force-renderer-accessibility \
  --window-position=3860,20 --window-size=640,560 \
  "file:///<abs-path>/experiments/e7-uia-keyboard/e7-target.html"

# 先探明哪个子窗口接收投递的按键
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -ProbeWidgets -TargetTitle 'E7' -NoPark

# 基线：不移动焦点直接打字（应进 t1，且前台不变）
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -Text 'AAA' -ParkProc SpectrAI

# 关键：UIA SetFocus 是否抢前台
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -FocusElement 'E7 Text B' -Text 'BBB' -ParkProc SpectrAI

# 组合拳：Tab 移焦 + 打字（注意等待时间）
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -SendTab -Text 'CCC' -StepSettleMs 1500 -ParkProc SpectrAI
```

## 6. 建议的下一步

1. **在有效前台环境下补测 Tab 路径**（本轮环境丢失了前台窗口）。判据：`park=ok` 且 `STAGE park: fg=<非 0>` 且全程不变。
2. **把"Tab 到达"变成可判定的事**：每步 Tab 后用 UIA 读一次当前 `activeElement`（UIA 只读不抢前台），确认到位再输入，而不是盲发固定次数。
3. **做一次完整的表单流程**：多字段依次 Tab + 输入，验证这条路径在真实任务里够不够用。
4. **给 E1–E7 收口**：把"通道能力矩阵 + 推荐形态"整理成一份总报告，替换散落在各实验里的结论。
