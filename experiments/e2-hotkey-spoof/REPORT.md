# E2 后台热键投递（线程级修饰键伪造）实验结果

- 实验日期：2026-10-12（紧接 E1）
- 机器：Windows 10 19045，单会话
- 脚手架：`E2HotkeySpoof.ps1`（PowerShell + 内联 C#，纯 USER32 文档化接口）
- 对应的研究假设：研究文档里的 **E2 后台快捷键**（`AttachThreadInput` + `SetKeyboardState`）
- **本实验同时推翻了 E1 关于 Chromium 的负结论，见第 4 节。**

## 1. 目的与判据

E2 假设：把目标窗口的输入队列挂接过来、直接写入修饰键状态，能否让**非前台** Chromium 窗口收到热键（Ctrl+A）。

| 判据 | 字段 | 通过条件 |
|---|---|---|
| 热键带修饰键送达 | `verdict.ctrlArrived` | true |
| 按键送达但不带修饰键 | `verdict.keyArrivedNoCtrl` | 用于区分「键到了但 ctrl 丢了」 |
| 用户光标零位移 | `cursor.dx` / `cursor.dy` | 均为 0 |
| 前台窗口全程不变 | `fg.stable` | true 且 `park.targetWasForeground=false` |
| **用户修饰键未被污染** | `selfCheck.polluted` | false（我们线程认为 Ctrl 按下、而物理 Ctrl 未按下 = 污染） |

## 2. 方法

**注入序列**（`-NoSpoof` 关闭伪造部分）：

```
AttachThreadInput(myTid, targetTid, TRUE)
  保存 GetKeyboardState 原始快照
  SetKeyboardState(..., VK_CONTROL = 0x80)        <- 写修饰键
  PostMessage(target, WM_KEYDOWN, 'A')
  PostMessage(target, WM_KEYUP,   'A')
  还原原始键盘状态
AttachThreadInput(myTid, targetTid, FALSE)
```

可选 `-AlsoCtrlKey`（额外投递一对真实 `VK_CONTROL` 按下/抬起）、`-WithActivationMsgs`（额外发送 E1 的 `WM_NCACTIVATE`/`WM_ACTIVATE`/`WM_SETFOCUS`）。

**读数通道（E2 的关键改进）**：E1 用位图差异判定，而 Chromium **不会重绘非活动窗口的内容**，因此位图完全没有读数能力。E2 改为让目标页面把事件写进 `document.title`，浏览器进程会更新窗口标题（与焦点无关），再用 `GetWindowText` 跨进程读回来：

```
E2-C<n>-K<m>-I<len>
   n   = 页面见到的 Ctrl+A 次数
   m   = 页面见到的 keydown 次数
   len = 当前 textarea 的值长度（即真正被插入的文字量）
```

**probe 模式**：对同一个窗口的每个候选注入点（顶层窗口 + 每个 `Chrome_RenderWidgetHostHWND` + D3D 窗口）分别跑「无伪造」和「有伪造」两遍。共运行 60+ 次。

## 3. 结果

全部为后台运行（`park=ok`、`targetWasForeground=false`），光标 `0×0`、前台窗口全程稳定、`polluted=false`（除注明外）。

### 3.1 页面**有**聚焦元素（`autofocus`）

| 组合 | 结果 | 说明 |
|---|---|---|
| 仅投递消息（无伪造、无激活消息） | `K` 增长 6→12 | **后台按键确实送达** |
| 投递消息 + 修饰键伪造 | `K` 增长，且 **`C` 增长 3→6** | **后台 Ctrl+A 生效** |
| 修饰键伪造（无激活消息） | `C` 增长 | 激活消息不是必需的 |
| E1 原始方法（`WM_KEYDOWN`+`WM_CHAR`） | `K` +30，`I` 2→60 | **30 个字符真的被插进了输入框** |
| 前台对照 | 干净的三态区分：`plain` → `E2-KEY-a`（键到、ctrl=false）；`spoof` → `E2-CTRLA-OK-n`（Ctrl+A 完整送达） | 投递路径与修饰键伪造均有效 |

### 3.2 页面**没有**聚焦元素（同一页面去掉 `autofocus`）

| 组合 | 结果 |
|---|---|
| 仅投递消息 | `K` 30→30，**两次运行均无任何送达** |
| 投递消息 + 激活消息 | 结论同上（该批 park 失败，落在前台，见局限） |

### 3.3 修饰键污染自检

所有伪造运行的 `selfCheck.polluted` 均为 `false`；`ctrlStillDownAfter=false`。还原 + 解挂之后，本线程和外部的 Ctrl 状态都没有残留。

## 4. 结论

1. **E1 对 Chromium 的负结论是错的，必须更正。** E1 报告「Chromium 切到后台后消息被静默丢弃（0 变更像素）」。E2 用窗口标题复现 E1 的原始方法，**30 个字符全部进了后台窗口的输入框**（`K` +30、`I` 2→60），标题从 `E2-CTRLA-OK-6` 变为 `E2-KEY-9`。真正的现象是：**Chromium 不重绘非活动窗口的内容**，所以位图差异把「已送达」读成了「没送达」。E1 里那 0 变更像素是读数假阴性，不是投递失败。
2. **后台按键投递在 Chromium 上可行，但要求页面内存在聚焦元素。** 有 `autofocus` 的页面在后台持续送达；把同一页面去掉 `autofocus` 后，同样条件、同样 `park=ok` 的后台运行两次全部无送达。
3. **后台热键可行，靠的是 `AttachThreadInput` + `SetKeyboardState`。** 只投递消息时键到了但 `ctrl=false`；加上修饰键伪造后 Ctrl+A 生效（`C` 递增）。这一条比 E1 的预期更乐观：**激活消息不是必需的**，修饰键伪造单独就够了。
4. **代价：用户看不到。** 因为 Chromium 不重绘非活动窗口，Agent 在后台往 Chromium 里打字时，界面**不会**反映出来，直到窗口被激活。对「不打扰用户」是好事；但它同时意味着**后台操作时不能靠截图自检**，必须改用 DOM/UIA/CDP 一类的非视觉读数——这一点是后续工程上的硬约束。
5. **零干扰成立**：全部运行光标位移 0、前台窗口 1680 ms 级采样内始终同一窗口、修饰键无残留。

## 5. 已知缺陷与局限

- **park 不稳定**：`SwitchToThisWindow` 把前台让给 SpectrAI 有时成功有时失败（`park=failed`）。所有 `park=failed` 的运行都被 `conclusive=false` 标出并排除在后台结论之外。3.2 节带激活消息的那一批就因此落到前台，未能参与判断。
- **聚焦元素的条件只做了「跨运行 A/B」**，没有在同一时刻对两个页面切换对比（两个页面是同一 Chrome 窗口的不同标签页，只有一个能处于选中态）。结论强度是「两次独立运行一致」，不是同一时刻的严格对照。
- **只测了 Ctrl+A**：Ctrl+C / Ctrl+V 未测（Ctrl+V 需要动系统剪贴板，会覆盖用户剪贴板，本次刻意没做）。
- **未测**：最小化窗口、中文输入法（`WM_IME_*`）、`Shift`/`Alt` 组合、DPI 缩放、多显示器坐标。
- **`I` 读数会被前一次选择干扰**：如果上一次 Ctrl+A 之后整个文本处于选中态，紧接着到来的普通字符会替换选区，`I` 会先掉到小值再增长。3.1 节 `I` 2→60 就是这个叠加上来的结果，判断依据是净增量 +30 与 `K` 的增量一致。
- **一次探测循环超时**：连续两轮 probe（20 次运行）触及 120 s 上限；单次 `-Mode run` 不受影响。

## 6. 复现

```bash
cd experiments/e2-hotkey-spoof

# 起目标窗口（独立 profile）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --user-data-dir=%TEMP%\e2-chrome-profile --no-first-run --window-size=1200,400 \
  "file:///<abs-path>/experiments/e2-hotkey-spoof/chromium-target.html"

# 单次运行（后台 + 修饰键伪造）
powershell -NoProfile -ExecutionPolicy Bypass -File E2HotkeySpoof.ps1 -Mode run \
  -TargetHwnd <hwnd> -InjectHwnd <renderwidget-hwnd> -Key A -ParkProc SpectrAI

# 候选注入点扫描（每种组合跑「无伪造/有伪造」两遍）
powershell -NoProfile -ExecutionPolicy Bypass -File E2HotkeySpoof.ps1 -Mode probe \
  -TargetTitle 'E2-' -ChildClass '^Chrome_RenderWidgetHostHWND$' -ParkProc SpectrAI

# 读回标题（真正的读数）
powershell -NoProfile -Command "Get-Process chrome | Where-Object { \$_.MainWindowTitle -like 'E2-*' } | Select-Object -ExpandProperty MainWindowTitle"
```

## 7. 建议的下一步

1. **给 Chromium 一个可用的后台读数通道**（UIA / CDP / `--force-renderer-accessibility`）。E2 证明后台操作确实生效，但截图不可用，"Agent 自己看不见"是当前最大的工程缺口。
2. **E3（虚拟屏 + 合成笔）**：本实验只覆盖键盘；点击路径的零位移能力仍未验证。
3. **把「必须有聚焦元素」做成前置检查**：Agent 在后台往 Chromium 打字前，应先确认目标页面存在聚焦元素，否则静默失败。
4. **把选控件规则固化**：一个主窗口下有多个 `Chrome_RenderWidgetHostHWND`，只有部分接收输入；本实验用 probe 逐点试出的顺序是可行的自动化方式。
