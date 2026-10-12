# E7 「UIA 定位 + 键盘输入」组合拳实验结果

- 日期：2026-10-12
- 状态：**已完成（含补测）**。首轮测量受环境干扰，补测在有效环境下拿到了直接证据
- 脚手架：`E7Combo.ps1`、`e7-target.html`
- 数据：同目录 `e7-result-*.json`
- 前置：E2（键盘通道不抢前台）、E6（UIA 动作抢前台）

## 1. 问题

E6 证明 UIA 动作会抢前台，键盘通道不会。把两者**组合**起来，能不能做到"把文字送进指定的那个控件，而全程不抢前台"？

组合的关键未知：**UIA `SetFocus()` 会不会抢前台？** 如果会，UIA 就只能做只读定位，焦点必须改用键盘（Tab）移动。

脚本的设计要点是**在每个阶段后各读一次前台**（park 后 / 聚焦后 / Tab 后 / 输入后），这样才能把前台变化归因到具体某一步，而不是靠总统计去猜。

## 2. 结论

### 2.1 补测结果（有效环境，直接证据）

`park=ok`/`ok-via-attach`、win 有效前台（`fg=48892734` = SpectrAI）：

| 运行 | 焦点操作 | 焦点变化 | 字符进入 | 光标 | 前台 |
|---|---|---|---|---|---|
| CONTROL | 无 | 保持 `F:t1` | `T1:3 → 6` ✅ | `0×0` | **`stable=true` `distinct=1`** ✅ |
| **TAB** | Tab（等 1.5 s） | **`F:t1 → F:t2`** ✅ | **`T2:0 → 3`** ✅ | `0×0` | **`stable=true` `distinct=1`** ✅ |
| TAB ×2 | Tab（等 1.5 s） | `F:t2 → F:b1` ✅ | ❌（按钮无编辑目标，符合预期） | `0×0` | **`stable=true` `distinct=1`** ✅ |

**三条结论（都有直接证据）：**

1. **UIA `SetFocus()` 会抢前台**（首轮 T2：park 后 `fg=48892734`(SpectrAI)，`SetFocus` 后变 `10490422`(Chrome)）。所以 **UIA 在这个组合里只能做只读的定位/校验，不能用来移动焦点**。
2. **键盘输入不抢前台**（CONTROL：`fg` 全程 `48892734`，`distinct=1`，字符进入 t1）。
3. **Tab 移动焦点同样不抢前台，而且之后字符能进目标控件**（TAB：`F:t1→F:t2`、`T2:0→3`，全程 `fg` 未变）。原先这条只有间接证据，**现已直接验证**。

### 2.2 首轮结果（部分测量无效，保留供对照）

| 测试 | 焦点操作 | 字符进入 | 光标 | 前台 |
|---|---|---|---|---|
| T1 基线 | 无（`autofocus`=t1） | t1 ✅ | `0×0` | **稳定（SpectrAI）** ✅ 有效 |
| T2 | **UIA `SetFocus`(t2)** | t2 ✅ | `0×0` | **被抢（SpectrAI→Chrome）** ✅ 有效 |
| T3 | `SetFocus`(t1) + Tab（**等 350 ms**） | ❌ | `0×0` | 不变 |
| R2 / TEST A | Tab（等 1.5 s） | **t2 ✅** | `0×0` | ⚠️ 当时 `fg=0`，测量无效 |

T3 与 R2 的对比给出了一个**容易踩的坑**：Tab 之后必须等足够久（**350 ms 会丢字符，1500 ms 才行**）。焦点移动是异步的（浏览器收键 → IPC → 渲染进程改焦点 → AX 树更新）。

## 3. 推荐的组合形态

```
1. UIA 只读定位     -> 找元素、读 Name/AutomationId/ControlType、确认可交互   （不抢前台）
2. 焦点用 Tab 移动  -> PostMessage(WM_KEYDOWN/WM_KEYUP, VK_TAB)，然后等 >=1.5s
3. 文字用 WM_CHAR   -> 逐字符投递                                          （不抢前台）
4. 全程不调用任何 UIA 动作（不 SetFocus、不 Invoke）
```

**成立范围**：目标必须能**从当前焦点位置"Tab 到达"**。Tab 环顺序不可控、目标可能在环的靠后位置，需要发多次 Tab（每步都该用 UIA 读一次 `activeElement` 确认到位再输入，而不是盲发固定次数）。**如果目标 Tab 不到，或者需要按坐标精确定位，这套组合不适用**——那种情况下只能接受一次前台切换，或依赖 `autofocus` 这类页面自身行为。

## 4. 一个实例级的投递失效（本轮新发现）

首轮之后的补测卡了很久，原因是：**前一个 Chrome 实例完全不接受投递的键盘消息**。

- `-ProbeWidgets` 对三个 RenderWidgetHost **全部返回 `changed=False`**；Tab 不移动焦点；字符不进入（`T1`/`T2` 恒为 0）。
- 该窗口本身状态**完全正常**：`IsWindow=1`、`IsWindowVisible=1`、`IsIconic=0`、`rect=4244,20–4884,580`（在虚拟屏内）、`IsWindowEnabled=1`；页面 JS 也活着（标题一直在正常渲染）。
- 换用**全新 profile 目录 + 主屏位置**重启后**立即** probe：三个候选**全部 `changed=True`**，随后所有测试正常。
- **根因未确定**（疑为该实例的输入路由 / 渲染进程状态问题，未做进一步取证）。

**实用含义**：不要把"进程在、窗口在、可见"当成"投递会被处理"。**投递键盘消息前应当先用 probe 确认当前实例是否真的接收**——这正是 `-ProbeWidgets` 的用途。这个坑同时也说明：E2 那类"键盘通道可行"的结论，需要以"目标实例健康"为前提。

## 5. 已知缺陷与局限

- **首轮后半段的"前台不变"测量无效**：系统中途真实失去前台窗口（`GetForegroundWindow()` 恒为 0，非锁屏：`LogonUI` 进程数为 0；且在输入桌面上：`OpenInputDesktop` 非 0）。`park`（含 `AttachThreadInput` 回退）、`WScript.Shell.AppActivate`、合成笔点击、窗口最小化+还原都救不回来。**已通过补测（§2.1）解决**，此处保留作为记录。
- **Tab 在页面边界会把焦点移出页面**：从最后一个页面元素再按 Tab，`document.activeElement` 变成 `-`（焦点去了浏览器 UI），并可能伴随前台变化。自动化时必须算准 Tab 次数，或每步用 UIA 读一次 `activeElement`。
- **合成笔点击会破坏 DOM 焦点**：本轮用合成笔激活 Chrome 窗口时，点击落在页面空白处，`activeElement` 直接变成 `-`。所以"用点击来建立焦点"这条路会丢焦点，需要事后重新用 Tab 定位。
- **只测了 Chromium**。UWP / 传统 Win32 的 Tab 行为未测（E6 显示 UWP 的 UIA 动作同样抢前台，但 Tab 路径没验证）。
- **未测多字段的完整表单流程**，只测了"移动一格并输入"。
- `--force-renderer-accessibility` 会让渲染进程变慢，1.5 s 是这个模式下的保守值，普通模式可能更短。

## 6. 复现

```bash
cd experiments/e7-uia-keyboard

# 起目标页（两个输入框 t1/t2 + 按钮，t1 带 autofocus）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir=%TEMP%\e7profile --no-first-run --force-renderer-accessibility \
  --window-position=600,100 --window-size=640,560 \
  "file:///<abs-path>/experiments/e7-uia-keyboard/e7-target.html"

# 第一步永远先 probe：确认这个实例真的接收投递
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -ProbeWidgets -TargetTitle 'E7' -NoPark

# 对照：不移动焦点直接打字（应进 t1，前台不变）
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -Text 'AAA' -ParkProc SpectrAI

# 关键：UIA SetFocus 是否抢前台
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -FocusElement 'E7 Text B' -Text 'BBB' -ParkProc SpectrAI

# 组合拳：Tab 移焦 + 打字（注意等待时间）
powershell -NoProfile -ExecutionPolicy Bypass -File E7Combo.ps1 -TargetTitle 'E7' -SendTab -Text 'CCC' -StepSettleMs 1500 -ParkProc SpectrAI
```

## 7. 建议的下一步

1. **把"Tab 到达"变成可判定的事**：每步 Tab 后用 UIA 读一次 `activeElement`（UIA 只读不抢前台），确认到位再输入。
2. **做一次完整的多字段表单流程**：连续 Tab + 输入，验证这条路径在真实任务里够不够用。
3. **给 E1–E7 收口**：整理一份"通道能力矩阵 + 推荐形态"总报告，替换现在散在 7 个实验目录里的结论。
